const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { Octokit } = require('@octokit/rest');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ]
});

// 环境配置
const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GH_TOKEN = process.env.GH_TOKEN;
const GH_REPO = process.env.GH_REPO; // 格式: "linmo004/sis"

// 顶帖配置
const INACTIVE_THRESHOLD = 23 * 60 * 60 * 1000; 
const CHECK_INTERVAL = 1 * 60 * 60 * 1000; 
const BUMP_MESSAGE_TEXT = '(⁠/⁠^⁠-⁠^⁠/⁠) 饱饱姐姐来顶帖啦，饱饱随心发不用担心找不到o';

const DB_FILE = path.join(__dirname, 'database.json');

// 初始本地数据库
let db = {
    bumpMessages: {},
    channelRestrictions: {}, // 格式: { "功能名称": "频道ID" }
    todos: [],
    anniversaries: [],
    clipboards: [],
    diaries: [],
    memories: [],      // 与 AI 经历了的名场面 { character, content, date }
    promptIdeas: [],   // 2500+ 待聊梗/灵感 { id, content }
    resources: []      // 资源库
};

// 加载数据库
function loadDB() {
    if (fs.existsSync(DB_FILE)) {
        try {
            const data = fs.readFileSync(DB_FILE, 'utf8');
            db = { ...db, ...JSON.parse(data) };
            console.log('(⁠•⁠̀⁠ᴗ⁠•⁠́⁠)⁠و 本地数据加载完毕！');
        } catch (err) {
            console.error('(⁠;⁠´⁠_⁠_⁠`⁠) 加载数据库失败:', err);
        }
    }
}

// 保存数据库并同步到 GitHub
function saveDB() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
        syncToGitHub('database.json', JSON.stringify(db, null, 2), '自动更新 Bot 内部数据库');
    } catch (err) {
        console.error('(⁠;⁠´⁠_⁠_⁠`⁠) 保存数据失败:', err);
    }
}

// GitHub 自动 Push / Pull 同步函数
async function syncToGitHub(filePath, content, commitMessage) {
    if (!GH_TOKEN || !GH_REPO) return;
    try {
        const octokit = new Octokit({ auth: GH_TOKEN });
        const [owner, repo] = GH_REPO.split('/');

        let sha;
        try {
            const { data } = await octokit.repos.getContent({ owner, repo, path: filePath });
            sha = data.sha;
        } catch (e) {
            sha = undefined; // 文件不存在则新建
        }

        await octokit.repos.createOrUpdateFileContents({
            owner,
            repo,
            path: filePath,
            message: commitMessage,
            content: Buffer.from(content).toString('base64'),
            sha
        });
        console.log(`(⁠•⁠̀⁠ᴗ⁠•⁠́⁠)⁠و 成功备份同步文件至 GitHub: ${filePath}`);
    } catch (err) {
        console.error('(⁠;⁠´⁠_⁠_⁠`⁠) GitHub 同步失败:', err);
    }
}

// 从 GitHub 读取备份文件
async function getBackupFromGitHub(filePath) {
    if (!GH_TOKEN || !GH_REPO) return null;
    try {
        const octokit = new Octokit({ auth: GH_TOKEN });
        const [owner, repo] = GH_REPO.split('/');
        const { data } = await octokit.repos.getContent({ owner, repo, path: filePath });
        const content = Buffer.from(data.content, 'base64').toString('utf8');
        return JSON.parse(content);
    } catch (err) {
        console.error('(⁠;⁠´⁠_⁠_⁠`⁠) 读取 GitHub 备份失败:', err);
        return null;
    }
}

loadDB();

// 注册斜杠指令
const commands = [
    new SlashCommandBuilder().setName('回顶').setDescription('生成一个可直接回到帖子顶部的快速跳转按钮'),
    
    // 动态频道绑定指令
    new SlashCommandBuilder()
        .setName('指定功能频道')
        .setDescription('将指定功能绑定到当前频道 (仅在该频道生效)')
        .addStringOption(o => o.setName('功能').setDescription('选择要绑定的功能模块').setRequired(true)
            .addChoices(
                { name: '纪念日提醒', value: '纪念日' },
                { name: '碎碎念日记', value: '日记' },
                { name: '无限剪贴板', value: '剪贴板' },
                { name: 'AI灵感梗库', value: '灵感梗' },
                { name: '名场面回忆录', value: '回忆录' },
                { name: '塔罗运势', value: '塔罗运势' }
            )),
    new SlashCommandBuilder().setName('查看功能绑定').setDescription('查看所有功能当前绑定的专用频道'),
    new SlashCommandBuilder().setName('解绑功能频道').setDescription('解除某项功能的频道限制，恢复全局可用')
        .addStringOption(o => o.setName('功能').setDescription('选择要解绑的功能').setRequired(true)
            .addChoices(
                { name: '纪念日提醒', value: '纪念日' },
                { name: '碎碎念日记', value: '日记' },
                { name: '无限剪贴板', value: '剪贴板' },
                { name: 'AI灵感梗库', value: '灵感梗' },
                { name: '名场面回忆录', value: '回忆录' },
                { name: '塔罗运势', value: '塔罗运势' }
            )),

    // 1. 每日随机决策
    new SlashCommandBuilder()
        .setName('随机决策')
        .setDescription('解决选择困难症！')
        .addStringOption(o => o.setName('类型').setDescription('选择类型').setRequired(true)
            .addChoices(
                { name: '吃什么', value: '吃什么' },
                { name: '看什么', value: '看什么' },
                { name: '玩什么', value: '玩什么' },
                { name: '学什么', value: '学什么' }
            )),

    // 2. 纪念日
    new SlashCommandBuilder()
        .setName('设置纪念日')
        .setDescription('添加纪念日及提前提醒')
        .addStringOption(o => o.setName('名称').setDescription('事项名称').setRequired(true))
        .addStringOption(o => o.setName('日期').setDescription('格式: YYYY-MM-DD').setRequired(true))
        .addIntegerOption(o => o.setName('提前天数').setDescription('提前几天提醒').setRequired(false)),
    new SlashCommandBuilder().setName('查看纪念日').setDescription('查看所有纪念日倒计时'),

    // 3. 便签
    new SlashCommandBuilder().setName('记便签').setDescription('添加备忘').addStringOption(o => o.setName('内容').setRequired(true)),
    new SlashCommandBuilder().setName('查看便签').setDescription('查看便签列表'),
    new SlashCommandBuilder().setName('删除便签').setDescription('删除指定便签').addIntegerOption(o => o.setName('编号').setRequired(true)),

    // 4. 塔罗与运势
    new SlashCommandBuilder().setName('每日运势').setDescription('抽取今日专属运势'),
    new SlashCommandBuilder().setName('塔罗占卜').setDescription('专业塔罗牌解读'),

    // 5. 无限剪贴板
    new SlashCommandBuilder().setName('存剪贴板').setDescription('永久保存文本/链接').addStringOption(o => o.setName('内容').setRequired(true)),
    new SlashCommandBuilder().setName('搜剪贴板').setDescription('检索历史剪贴板').addStringOption(o => o.setName('关键词').setRequired(true)),

    // 6. 摇号与骰子
    new SlashCommandBuilder().setName('灵感摇号').setDescription('从多选项中随机摇号').addStringOption(o => o.setName('选项').setDescription('空格隔开').setRequired(true)),
    new SlashCommandBuilder().setName('掷骰').setDescription('随机抽取数字').addIntegerOption(o => o.setName('最大值').setRequired(false)),

    // 7. 碎碎念日记
    new SlashCommandBuilder().setName('写日记').setDescription('记录心情胶囊').addStringOption(o => o.setName('内容').setRequired(true)),
    new SlashCommandBuilder().setName('随机日记').setDescription('随机抽取开盒过去的一篇日记'),
    new SlashCommandBuilder().setName('搜日记').setDescription('按关键词或日期查找日记').addStringOption(o => o.setName('查询内容').setRequired(true)),

    // 8. 模块A：AI 待聊梗/灵感 (2500+ 专属)
    new SlashCommandBuilder().setName('抽灵感梗').setDescription('随机抽取一个可以和 AI 聊的灵感/梗'),
    new SlashCommandBuilder().setName('搜灵感梗').setDescription('搜索灵感梗库').addStringOption(o => o.setName('关键词').setRequired(true)),

    // 9. 模块B：与 AI 经历过的名场面回忆
    new SlashCommandBuilder().setName('存回忆').setDescription('记录与角色经历过的甜爆/名场面')
        .addStringOption(o => o.setName('角色').setRequired(true))
        .addStringOption(o => o.setName('剧情').setRequired(true)),
    new SlashCommandBuilder().setName('看回忆').setDescription('回顾与角色的历史名场面')
        .addStringOption(o => o.setName('角色').setDescription('不填则随机全部角色').setRequired(false)),

    // 10. 全社区手动备份与一键还原
    new SlashCommandBuilder().setName('全社区备份').setDescription('立刻覆盖备份整个 Discord 社区所有聊天记录与帖子到 GitHub'),
    new SlashCommandBuilder().setName('还原社区').setDescription('【慎用】从 GitHub 备份中重建并还原所有频道、论坛和聊天历史记录')
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);

client.once('ready', async () => {
    console.log(`(⁠•⁠̀⁠ᴗ⁠•⁠́⁠)⁠و 机器人已登录：${client.user.tag}`);
    try {
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        console.log('(⁠•⁠̀⁠ᴗ⁠•⁠́⁠)⁠و 斜杠指令注册完成！');
    } catch (err) {
        console.error('(⁠;⁠´⁠_⁠_⁠`⁠) 指令注册异常:', err);
    }
    setInterval(checkAndBumpThreads, CHECK_INTERVAL);
    setInterval(autoBackupCommunity, 24 * 60 * 60 * 1000); // 每天自动覆盖备份一次社区
});

// 防沉检测
async function checkAndBumpThreads() {
    try {
        for (const guild of client.guilds.cache.values()) {
            const activeThreads = await guild.channels.fetchActiveThreads();
            const now = Date.now();

            for (const thread of activeThreads.threads.values()) {
                if (thread.locked) continue;
                const lastMessage = thread.lastMessageId ? await thread.messages.fetch(thread.lastMessageId).catch(() => null) : null;

                if (lastMessage && (now - lastMessage.createdTimestamp > INACTIVE_THRESHOLD)) {
                    const oldBumpMsgId = db.bumpMessages[thread.id];
                    if (oldBumpMsgId) {
                        try {
                            const oldMsg = await thread.messages.fetch(oldBumpMsgId).catch(() => null);
                            if (oldMsg) await oldMsg.delete();
                        } catch (err) {}
                    }
                    const newMsg = await thread.send(BUMP_MESSAGE_TEXT);
                    db.bumpMessages[thread.id] = newMsg.id;
                    saveDB();
                }
            }
        }
    } catch (err) {
        console.error('防沉检测异常:', err);
    }
}

// 核心：全社区聊天记录与帖子抓取 -> **全量覆盖备份** 到 GitHub
async function autoBackupCommunity() {
    console.log('(⁠*⁠´⁠ω⁠｀⁠*⁠) 开始全量抓取全社区聊天历史与帖子数据...');
    let fullBackupData = {
        last_updated: new Date().toLocaleString(),
        channels: {}
    };

    try {
        for (const guild of client.guilds.cache.values()) {
            const channels = await guild.channels.fetch();
            for (const channel of channels.values()) {
                if (!channel || !channel.isTextBased()) continue;

                let channelData = { name: channel.name, type: channel.type, messages: [], threads: [] };

                // 抓取频道前 100 条历史消息
                const msgs = await channel.messages.fetch({ limit: 100 }).catch(() => null);
                if (msgs) {
                    msgs.forEach(m => {
                        if (!m.author.bot) { // 过滤掉机器人自己的系统消息
                            channelData.messages.unshift({ author: m.author.tag, content: m.content, time: m.createdAt });
                        }
                    });
                }

                // 抓取论坛帖子 Thread 内部消息
                if (channel.threads) {
                    const threads = await channel.threads.fetchActive().catch(() => null);
                    if (threads) {
                        for (const thread of threads.threads.values()) {
                            let threadData = { name: thread.name, messages: [] };
                            const tMsgs = await thread.messages.fetch({ limit: 100 }).catch(() => null);
                            if (tMsgs) {
                                tMsgs.forEach(tm => {
                                    if (!tm.author.bot) {
                                        threadData.messages.unshift({ author: tm.author.tag, content: tm.content, time: tm.createdAt });
                                    }
                                });
                            }
                            channelData.threads.push(threadData);
                        }
                    }
                }
                fullBackupData.channels[channel.name] = channelData;
            }
        }

        const updateTimeStr = new Date().toISOString().slice(0, 10);
        await syncToGitHub('community_backup.json', JSON.stringify(fullBackupData, null, 2), `全社区覆盖更新备份: ${updateTimeStr}`);
    } catch (err) {
        console.error('(⁠;⁠´⁠_⁠_⁠`⁠) 社区全量备份失败:', err);
    }
}

// 检查指令频道限制的辅助函数
function checkChannelRestriction(interaction, featureKey) {
    const boundChannelId = db.channelRestrictions[featureKey];
    if (boundChannelId && interaction.channelId !== boundChannelId) {
        interaction.reply({ 
            content: `(⁠・⁠_⁠・⁠;⁠) 为了保持界面整洁，**【${featureKey}】** 功能已被限制在专用频道 <#${boundChannelId}> 使用哦！`, 
            ephemeral: true 
        });
        return false;
    }
    return true;
}

// 塔罗牌数据
const TAROT_CARDS = [
    { name: '愚人', position: '正位', desc: '新的开始、冒险、无限可能性。' },
    { name: '魔术师', position: '正位', desc: '创造力、行动力、展现能力。' },
    { name: '恋人', position: '正位', desc: '爱与和谐、契合的联结、重要抉择。' },
    { name: '命运之轮', position: '正位', desc: '转折点、命运的安排、周期循环。' },
    { name: '星星', position: '正位', desc: '希望、灵感、治愈、美好的愿景。' }
];

// 指令响应
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName } = interaction;

    // --- 频道绑定管理逻辑 ---
    if (commandName === '指定功能频道') {
        const feature = interaction.options.getString('功能');
        db.channelRestrictions[feature] = interaction.channelId;
        saveDB();
        return interaction.reply(`(⁠*⁠^⁠-⁠^⁠*⁠) 绑定成功！已将功能 **【${feature}】** 限定在当前频道 <#${interaction.channelId}> 使用！`);
    }
    if (commandName === '解绑功能频道') {
        const feature = interaction.options.getString('功能');
        delete db.channelRestrictions[feature];
        saveDB();
        return interaction.reply(`(⁠*⁠^⁠-⁠^⁠*⁠) 已解除 **【${feature}】** 的频道限制，现在可以在任何地方使用啦！`);
    }
    if (commandName === '查看功能绑定') {
        const keys = Object.keys(db.channelRestrictions);
        if (keys.length === 0) return interaction.reply('(⁠*⁠^⁠-⁠^⁠*⁠) 目前所有功能都处于【全局可用】状态，没有设置频道限制。');
        const list = keys.map(k => `• **${k}** ➔ 限定频道: <#${db.channelRestrictions[k]}>`).join('\n');
        return interaction.reply(`(⁠/⁠^⁠-⁠^⁠/⁠) **当前功能频道绑定清单：**\n${list}`);
    }

    if (commandName === '回顶') {
        if (!interaction.channel.isThread()) return interaction.reply({ content: '(⁠・⁠_⁠・⁠;⁠) 只能在帖子内部使用哦！', ephemeral: true });
        const topMessageUrl = `https://discord.com/channels/${interaction.guildId}/${interaction.channel.id}/${interaction.channel.id}`;
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('(^ - ^)/ 饱饱急急慢不要来~姐姐来啦 点击直达帖子顶部').setStyle(ButtonStyle.Link).setURL(topMessageUrl)
        );
        return interaction.reply({ content: '(⁠*⁠^⁠-⁠^⁠*⁠) 摸摸饱饱 点击下方按钮即可快速返回首条消息：', components: [row] });
    }

    // --- 各功能区域 (包含频道校验) ---

    // 纪念日
    if (commandName === '设置纪念日' || commandName === '查看纪念日') {
        if (!checkChannelRestriction(interaction, '纪念日')) return;

        if (commandName === '设置纪念日') {
            const name = interaction.options.getString('名称');
            const date = interaction.options.getString('日期');
            const advanceDays = interaction.options.getInteger('提前天数') || 3;
            db.anniversaries.push({ name, date, advanceDays });
            saveDB();
            return interaction.reply(`(⁠*⁠^⁠-⁠^⁠*⁠) 已记录纪念日 **【${name}】** (${date})！`);
        }
        if (commandName === '查看纪念日') {
            if (db.anniversaries.length === 0) return interaction.reply('(⁠*⁠^⁠-⁠^⁠*⁠) 目前还没有记录任何纪念日哦！');
            const list = db.anniversaries.map((x, i) => `${i + 1}. **${x.name}** (${x.date})`).join('\n');
            return interaction.reply(`(⁠/⁠^⁠-⁠^⁠/⁠) **纪念日清单：**\n${list}`);
        }
    }

    // 剪贴板
    if (commandName === '存剪贴板' || commandName === '搜剪贴板') {
        if (!checkChannelRestriction(interaction, '剪贴板')) return;

        if (commandName === '存剪贴板') {
            const content = interaction.options.getString('内容');
            db.clipboards.push({ content, date: new Date().toLocaleString() });
            saveDB();
            return interaction.reply(`(⁠•⁠̀⁠ᴗ⁠•⁠́⁠)⁠و 已存入剪贴板档案库！`);
        }
        if (commandName === '搜剪贴板') {
            const keyword = interaction.options.getString('关键词');
            const results = db.clipboards.filter(x => x.content.includes(keyword));
            if (results.length === 0) return interaction.reply(`(⁠・⁠_⁠・⁠;⁠) 未查找到包含关键词 [${keyword}] 的记录。`);
            const list = results.map((x, i) => `${i + 1}. [${x.date}] ${x.content}`).slice(0, 5).join('\n');
            return interaction.reply(`(⁠/⁠^⁠-⁠^⁠/⁠) **剪贴板检索结果：**\n${list}`);
        }
    }

    // 碎碎念日记
    if (commandName === '写日记' || commandName === '随机日记' || commandName === '搜日记') {
        if (!checkChannelRestriction(interaction, '日记')) return;

        if (commandName === '写日记') {
            const content = interaction.options.getString('内容');
            db.diaries.push({ date: new Date().toISOString().slice(0, 10), content });
            saveDB();
            return interaction.reply(`(⁠*⁠^⁠-⁠^⁠*⁠) 日记胶囊已封存！`);
        }
        if (commandName === '随机日记') {
            if (db.diaries.length === 0) return interaction.reply('(⁠・⁠_⁠・⁠;⁠) 还没有写过日记哦！');
            const item = db.diaries[Math.floor(Math.random() * db.diaries.length)];
            return interaction.reply(`(⁠/⁠^⁠-⁠^⁠/⁠) **开启历史日记胶囊 [${item.date}]：**\n> ${item.content}`);
        }
    }

    // 模块 A：抽/搜灵感梗
    if (commandName === '抽灵感梗' || commandName === '搜灵感梗') {
        if (!checkChannelRestriction(interaction, '灵感梗')) return;

        if (commandName === '抽灵感梗') {
            if (db.promptIdeas.length === 0) return interaction.reply('(⁠・⁠_⁠・⁠;⁠) 梗库目前是空的哦！可以将 Excel 里的灵感导入存入。');
            const item = db.promptIdeas[Math.floor(Math.random() * db.promptIdeas.length)];
            return interaction.reply(`(⁠/⁠^⁠-⁠^⁠/⁠) **为您抽取一个与 AI 互动灵感梗：**\n> ${item.content}`);
        }
    }

    // 模块 B：存/看回忆
    if (commandName === '存回忆' || commandName === '看回忆') {
        if (!checkChannelRestriction(interaction, '回忆录')) return;

        if (commandName === '存回忆') {
            const char = interaction.options.getString('角色');
            const content = interaction.options.getString('剧情');
            db.memories.push({ character: char, content, date: new Date().toISOString().slice(0, 10) });
            saveDB();
            return interaction.reply(`(⁠*⁠^⁠-⁠^⁠*⁠) 已为您保存与角色 **【${char}】** 的名场面回忆！`);
        }
        if (commandName === '看回忆') {
            const char = interaction.options.getString('角色');
            let filtered = char ? db.memories.filter(x => x.character === char) : db.memories;
            if (filtered.length === 0) return interaction.reply(`(⁠・⁠_⁠・⁠;⁠) 还没有记录过 ${char ? '角色【' + char + '】的' : ''}名场面回忆哦！`);
            const item = filtered[Math.floor(Math.random() * filtered.length)];
            return interaction.reply(`(⁠/⁠^⁠-⁠^⁠/⁠) **重温名场面 [角色: ${item.character}] (${item.date})：**\n> ${item.content}`);
        }
    }

    // 塔罗占卜
    if (commandName === '塔罗占卜' || commandName === '每日运势') {
        if (!checkChannelRestriction(interaction, '塔罗运势')) return;

        const card = TAROT_CARDS[Math.floor(Math.random() * TAROT_CARDS.length)];
        return interaction.reply(`(⁠*⁠^⁠-⁠^⁠*⁠) **塔罗牌抽卡：**\n> 牌面：**【${card.name}】** (${card.position})\n> 牌意：${card.desc}`);
    }

    // 社区全量备份
    if (commandName === '全社区备份') {
        await interaction.deferReply();
        await autoBackupCommunity();
        return interaction.editReply('(⁠•⁠̀⁠ᴗ⁠•⁠́⁠)⁠و 全社区聊天历史与帖子已成功抓取，并直接覆盖更新提交至 GitHub 的 `community_backup.json` 文件！');
    }

    // 🌟 一键还原社区脚本 🌟
    if (commandName === '还原社区') {
        await interaction.deferReply();
        const backupData = await getBackupFromGitHub('community_backup.json');
        if (!backupData || !backupData.channels) {
            return interaction.editReply('(⁠;⁠´⁠_⁠_⁠`⁠) 无法从 GitHub 读取备份文件 `community_backup.json`，还原中断。');
        }

        const guild = interaction.guild;
        try {
            await interaction.editReply(`(⁠*⁠´⁠ω⁠｀⁠*⁠) 开始读取备份数据（备份时间: ${backupData.last_updated}），准备重建社区架构...`);

            for (const [chanName, chanData] of Object.entries(backupData.channels)) {
                // 检查频道是否已存在，不存在则新建
                let targetChannel = guild.channels.cache.find(c => c.name === chanName);
                if (!targetChannel) {
                    targetChannel = await guild.channels.create({
                        name: chanName,
                        type: chanData.type || ChannelType.GuildText
                    });
                }

                // 还原普通频道历史消息
                if (chanData.messages && chanData.messages.length > 0 && targetChannel.isTextBased()) {
                    for (const m of chanData.messages) {
                        const timeStr = new Date(m.time).toLocaleString();
                        await targetChannel.send(`📜 **[${timeStr}] ${m.author}**: ${m.content}`).catch(() => null);
                    }
                }

                // 还原论坛帖子 Threads 及内部消息
                if (chanData.threads && chanData.threads.length > 0 && targetChannel.threads) {
                    for (const threadData of chanData.threads) {
                        let newThread = await targetChannel.threads.create({
                            name: threadData.name,
                            autoArchiveDuration: 60,
                            reason: '备份社区自动还原'
                        }).catch(() => null);

                        if (newThread && threadData.messages) {
                            for (const tm of threadData.messages) {
                                const tmTimeStr = new Date(tm.time).toLocaleString();
                                await newThread.send(`📜 **[${tmTimeStr}] ${tm.author}**: ${tm.content}`).catch(() => null);
                            }
                        }
                    }
                }
            }

            return interaction.followUp('(⁠•⁠̀⁠ᴗ⁠•⁠́⁠)⁠و **社区结构与历史消息已成功从 GitHub 备份中全部重建还原！**');
        } catch (err) {
            console.error('还原社区出现异常:', err);
            return interaction.followUp('(⁠;⁠´⁠_⁠_⁠`⁠) 还原过程中发生错误，请检查机器人是否拥有管理频道的权限。');
        }
    }
});

client.login(TOKEN);
// 专门骗过 Render Web Service 端口检测的小 HTTP 服务
const http = require('http');
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running smooth! (⁠•⁠̀⁠ᴗ⁠•⁠́⁠)⁠و');
}).listen(PORT, () => {
    console.log(`(⁠•⁠̀⁠ᴗ⁠•⁠́⁠)⁠و 端口监听已启动: ${PORT}`);
});
