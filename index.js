const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { Octokit } = require('@octokit/rest');
const http = require('http');

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

// 防沉/顶帖配置
const INACTIVE_THRESHOLD = 23 * 60 * 60 * 1000; 
const CHECK_INTERVAL = 1 * 60 * 60 * 1000; 
const BUMP_MESSAGE_TEXT = '(⁠/⁠^⁠-⁠^⁠/⁠) 饱饱姐姐来顶帖啦，饱饱随心发不用担心找不到o';

const DB_FILE = path.join(__dirname, 'database.json');

// 初始本地数据库结构
let db = {
    bumpMessages: {},
    channelRestrictions: {}, 
    todos: [],
    anniversaries: [],
    clipboards: [],
    diaries: [],
    memories: [],      
    promptIdeas: [],   
    resources: []      
};

// 防抖同步机制
let saveTimer = null;

// 从 GitHub 读取远程最新数据库（突破 1MB 限制并防止覆盖）
async function loadDBFromGitHub() {
    if (!GH_TOKEN || !GH_REPO) {
        console.log('⚠️ 未配置 GH_TOKEN 或 GH_REPO，将仅使用本地数据库');
        return loadDBLocal();
    }
    try {
        console.log('⏳ 正在从 GitHub 拉取最新的全量数据库...');
        const octokit = new Octokit({ auth: GH_TOKEN });
        const [owner, repo] = GH_REPO.split('/');

        const { data } = await octokit.repos.getContent({ owner, repo, path: 'database.json' });
        
        if (data && data.download_url) {
            const res = await fetch(data.download_url);
            if (res.ok) {
                const remoteDB = await res.json();
                db = { ...db, ...remoteDB };
                fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
                console.log(`(⁠•⁠̀⁠ᴗ⁠•⁠́⁠)⁠و 成功从 GitHub 同步最新数据库！目前共有 ${db.promptIdeas ? db.promptIdeas.length : 0} 条梗！`);
                return;
            }
        }
        loadDBLocal();
    } catch (err) {
        console.error('(⁠;⁠´⁠_⁠_⁠`⁠) 从 GitHub 拉取数据库失败，回退到本地加载:', err.message);
        loadDBLocal();
    }
}

// 备用本地加载函数
function loadDBLocal() {
    if (fs.existsSync(DB_FILE)) {
        try {
            const data = fs.readFileSync(DB_FILE, 'utf8');
            db = { ...db, ...JSON.parse(data) };
            console.log('(⁠•⁠̀⁠ᴗ⁠•⁠́⁠)⁠و 已加载本地缓存数据库！');
        } catch (err) {
            console.error('(⁠;⁠´⁠_⁠_⁠`⁠) 加载本地数据库失败:', err);
        }
    }
}

// 保存本地数据库，并使用防抖异步同步至 GitHub
function saveDB() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            syncToGitHub('database.json', JSON.stringify(db, null, 2), '自动更新 Bot 数据库');
        }, 5000);
    } catch (err) {
        console.error('(⁠;⁠´⁠_⁠_⁠`⁠) 保存数据失败:', err);
    }
}

// GitHub 自动 Push 同步函数
async function syncToGitHub(filePath, content, commitMessage) {
    if (!GH_TOKEN || !GH_REPO) return;
    try {
        const octokit = new Octokit({ auth: GH_TOKEN });
        const [owner, repo] = GH_REPO.split('/');

        let sha;
        try {
            const { data } = await octokit.repos.getContent({ owner, repo, path: filePath });
            sha = Array.isArray(data) ? undefined : data.sha;
        } catch (e) {
            sha = undefined; 
        }

        await octokit.repos.createOrUpdateFileContents({
            owner,
            repo,
            path: filePath,
            message: commitMessage,
            content: Buffer.from(content).toString('base64'),
            sha
        });
        console.log(`(⁠•⁠̀⁠ᴗ⁠•⁠́⁠)⁠و 成功同步数据文件至 GitHub: ${filePath}`);
    } catch (err) {
        console.error('(⁠;⁠´⁠_⁠_⁠`⁠) GitHub 同步失败:', err.message);
    }
}

// 从 GitHub 读取备份文件
async function getBackupFromGitHub(filePath) {
    if (!GH_TOKEN || !GH_REPO) return null;
    try {
        const octokit = new Octokit({ auth: GH_TOKEN });
        const [owner, repo] = GH_REPO.split('/');
        const { data } = await octokit.repos.getContent({ owner, repo, path: filePath });
        if (data.download_url) {
            const res = await fetch(data.download_url);
            return await res.json();
        }
        return null;
    } catch (err) {
        console.error('(⁠;⁠´⁠_⁠_⁠`⁠) 读取 GitHub 备份失败:', err);
        return null;
    }
}

// 注册斜杠指令
const commands = [
    new SlashCommandBuilder().setName('回顶').setDescription('生成一个可直接回到帖子顶部的快速跳转按钮'),
    
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
                { name: '塔罗运势', value: '塔罗运势' },
                { name: '资源档案馆', value: '资源库' }
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
                { name: '塔罗运势', value: '塔罗运势' },
                { name: '资源档案馆', value: '资源库' }
            )),

    new SlashCommandBuilder()
        .setName('随机决策')
        .setDescription('解决选择困难症！')
        .addStringOption(o => o.setName('类型').setDescription('选择决策类型').setRequired(true)
            .addChoices(
                { name: '吃什么', value: '吃什么' },
                { name: '看什么', value: '看什么' },
                { name: '玩什么', value: '玩什么' },
                { name: '学什么', value: '学什么' }
            )),

    new SlashCommandBuilder()
        .setName('设置纪念日')
        .setDescription('添加纪念日及提前提醒')
        .addStringOption(o => o.setName('名称').setDescription('事项名称').setRequired(true))
        .addStringOption(o => o.setName('日期').setDescription('格式: YYYY-MM-DD').setRequired(true))
        .addIntegerOption(o => o.setName('提前天数').setDescription('提前几天提醒').setRequired(false)),
    new SlashCommandBuilder().setName('查看纪念日').setDescription('查看所有纪念日倒计时'),

    new SlashCommandBuilder().setName('记便签').setDescription('添加备忘便签').addStringOption(o => o.setName('内容').setDescription('要记录的便签内容').setRequired(true)),
    new SlashCommandBuilder().setName('查看便签').setDescription('查看便签列表'),
    new SlashCommandBuilder().setName('删除便签').setDescription('删除指定便签').addIntegerOption(o => o.setName('编号').setDescription('要删除的便签序号').setRequired(true)),

    new SlashCommandBuilder().setName('每日运势').setDescription('抽取今日专属运势'),
    new SlashCommandBuilder().setName('塔罗占卜').setDescription('专业塔罗牌解读'),

    new SlashCommandBuilder().setName('存剪贴板').setDescription('永久保存文本/链接/私人档案').addStringOption(o => o.setName('内容').setDescription('要保存的文本或链接').setRequired(true)),
    new SlashCommandBuilder().setName('搜剪贴板').setDescription('检索历史剪贴板档案').addStringOption(o => o.setName('关键词').setDescription('要搜索的关键词').setRequired(true)),

    new SlashCommandBuilder().setName('灵感摇号').setDescription('从多选项中随机摇号').addStringOption(o => o.setName('选项').setDescription('用空格隔开各个选项').setRequired(true)),
    new SlashCommandBuilder().setName('掷骰').setDescription('随机抽取数字').addIntegerOption(o => o.setName('最大值').setDescription('骰子最大数字(默认6)').setRequired(false)),

    new SlashCommandBuilder().setName('写日记').setDescription('记录心情胶囊').addStringOption(o => o.setName('内容').setDescription('日记内容').setRequired(true)),
    new SlashCommandBuilder().setName('随机日记').setDescription('随机抽取开盒过去的一篇日记'),
    new SlashCommandBuilder().setName('搜日记').setDescription('按关键词或日期查找日记').addStringOption(o => o.setName('查询内容').setDescription('关键词或日期').setRequired(true)),

    new SlashCommandBuilder().setName('抽灵感梗').setDescription('随机抽取一个可以和 AI 聊的灵感/梗'),
    new SlashCommandBuilder().setName('搜灵感梗').setDescription('搜索灵感梗库').addStringOption(o => o.setName('关键词').setDescription('关键词').setRequired(true)),

    new SlashCommandBuilder().setName('存回忆').setDescription('记录与角色经历过的甜爆/名场面')
        .addStringOption(o => o.setName('角色').setDescription('角色名字').setRequired(true))
        .addStringOption(o => o.setName('剧情').setDescription('名场面剧情描述').setRequired(true)),
    new SlashCommandBuilder().setName('看回忆').setDescription('回顾与角色的历史名场面')
        .addStringOption(o => o.setName('角色').setDescription('不填则随机全部角色').setRequired(false)),

    new SlashCommandBuilder()
        .setName('存资源')
        .setDescription('录入资源至档案馆（角色卡/世界书/预设/美化等）')
        .addStringOption(o => o.setName('名称').setDescription('资源名称').setRequired(true))
        .addStringOption(o => o.setName('分类').setDescription('资源分类').setRequired(true)
            .addChoices(
                { name: '角色卡', value: '角色卡' },
                { name: '世界书', value: '世界书' },
                { name: '预设', value: '预设' },
                { name: '小手机', value: '小手机' },
                { name: '美化', value: '美化' },
                { name: '其他', value: '其他' }
            ))
        .addStringOption(o => o.setName('作者').setDescription('作者名').setRequired(false))
        .addStringOption(o => o.setName('链接').setDescription('资源文件链接或外部链接').setRequired(false))
        .addStringOption(o => o.setName('备注').setDescription('备注说明').setRequired(false)),

    new SlashCommandBuilder()
        .setName('搜资源')
        .setDescription('检索与交叉筛选档案馆资源')
        .addStringOption(o => o.setName('分类').setDescription('按分类筛选').setRequired(false)
            .addChoices(
                { name: '角色卡', value: '角色卡' },
                { name: '世界书', value: '世界书' },
                { name: '预设', value: '预设' },
                { name: '小手机', value: '小手机' },
                { name: '美化', value: '美化' },
                { name: '其他', value: '其他' }
            ))
        .addStringOption(o => o.setName('作者').setDescription('按作者筛选').setRequired(false))
        .addStringOption(o => o.setName('关键词').setDescription('搜索名称/备注中的关键词').setRequired(false)),

    new SlashCommandBuilder()
        .setName('抓取本帖资源')
        .setDescription('【论坛专享】自动抓取当前帖子的文件与内容并生成预览入库卡片'),

    new SlashCommandBuilder().setName('全社区备份').setDescription('立刻覆盖备份整个 Discord 社区所有聊天记录与帖子到 GitHub'),
    new SlashCommandBuilder().setName('还原社区').setDescription('【慎用】从 GitHub 备份中重建并还原所有频道、论坛和聊天历史记录')
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);

client.once('ready', async () => {
    console.log(`(⁠•⁠̀⁠ᴗ⁠•⁠́⁠)⁠و 机器人已登录：${client.user.tag}`);
    await loadDBFromGitHub();

    try {
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        console.log('(⁠•⁠̀⁠ᴗ⁠•⁠́⁠)⁠و 斜杠指令注册完成！');
    } catch (err) {
        console.error('(⁠;⁠´⁠_⁠_⁠`⁠) 指令注册异常:', err);
    }
    setInterval(checkAndBumpThreads, CHECK_INTERVAL);
    setInterval(autoBackupCommunity, 24 * 60 * 60 * 1000); 
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

// 全社区全量备份
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

                const msgs = await channel.messages.fetch({ limit: 100 }).catch(() => null);
                if (msgs) {
                    msgs.forEach(m => {
                        if (!m.author.bot) {
                            channelData.messages.unshift({ author: m.author.tag, content: m.content, time: m.createdAt });
                        }
                    });
                }

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

// 检查频道绑定 (改为仅自己可见提示)
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

const DECISION_PRESETS = {
    '吃什么': ['火锅', '烧烤', '麻辣烫', '日料寿司', '肯德基/麦当劳', '轻食沙拉', '螺蛳粉', '家常炒菜', '喝奶茶代餐!'],
    '看什么': ['热门新番动画', '悬疑烧脑电影', '轻松搞笑综艺', '治治愈系纪录片', '高分美剧/韩剧', '经典老片重温'],
    '玩什么': ['单机游戏大作', 'Steam 独立小游戏', '去灵感梗库抽卡与 AI 聊天', '整理 Discord 社区', '听音乐放松'],
    '学什么': ['敲一段新代码', '学个 Prompt 提示词技巧', '看一本技术/人文书', '背 20 个新单词', '研究一个新的小工具']
};

const TAROT_CARDS = [
    { name: '愚人', position: '正位', desc: '新的开始、冒险、无限可能性。' },
    { name: '魔术师', position: '正位', desc: '创造力、行动力、展现能力。' },
    { name: '恋人', position: '正位', desc: '爱与和谐、契合的联结、重要抉择。' },
    { name: '命运之轮', position: '正位', desc: '转折点、命运的安排、周期循环。' },
    { name: '星星', position: '正位', desc: '希望、灵感、治愈、美好的愿景。' }
];

// 指令交互监听 (全部回复已设置为 ephemeral: true)
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName } = interaction;

    // 绑定/解绑频道
    if (commandName === '指定功能频道') {
        const feature = interaction.options.getString('功能');
        db.channelRestrictions[feature] = interaction.channelId;
        saveDB();
        return interaction.reply({ content: `(⁠*⁠^⁠-⁠^⁠*⁠) 绑定成功！已将功能 **【${feature}】** 限定在当前频道 <#${interaction.channelId}> 使用！`, ephemeral: true });
    }
    if (commandName === '解绑功能频道') {
        const feature = interaction.options.getString('功能');
        delete db.channelRestrictions[feature];
        saveDB();
        return interaction.reply({ content: `(⁠*⁠^⁠-⁠^⁠*⁠) 已解除 **【${feature}】** 的频道限制，现在可以在任何地方使用啦！`, ephemeral: true });
    }
    if (commandName === '查看功能绑定') {
        const keys = Object.keys(db.channelRestrictions);
        if (keys.length === 0) return interaction.reply({ content: '(⁠*⁠^⁠-⁠^⁠*⁠) 目前所有功能都处于【全局可用】状态，没有设置频道限制。', ephemeral: true });
        const list = keys.map(k => `• **${k}** ➔ 限定频道: <#${db.channelRestrictions[k]}>`).join('\n');
        return interaction.reply({ content: `(⁠/⁠^⁠-⁠^⁠/⁠) **当前功能频道绑定清单：**\n${list}`, ephemeral: true });
    }

    if (commandName === '回顶') {
        if (!interaction.channel.isThread()) return interaction.reply({ content: '(⁠・⁠_⁠・⁠;⁠) 只能在帖子内部使用哦！', ephemeral: true });
        const topMessageUrl = `https://discord.com/channels/${interaction.guildId}/${interaction.channel.id}/${interaction.channel.id}`;
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('(^ - ^)/ 饱饱急急慢不要来~姐姐来啦 点击直达帖子顶部').setStyle(ButtonStyle.Link).setURL(topMessageUrl)
        );
        return interaction.reply({ content: '(⁠*⁠^⁠-⁠^⁠*⁠) 摸摸饱饱 点击下方按钮即可快速返回首条消息：', components: [row], ephemeral: true });
    }

    // 随机决策 / 摇号 / 骰子
    if (commandName === '随机决策') {
        const type = interaction.options.getString('类型');
        const choices = DECISION_PRESETS[type] || ['选项A', '选项B'];
        const result = choices[Math.floor(Math.random() * choices.length)];
        return interaction.reply({ content: `(⁠/⁠^⁠-⁠^⁠/⁠) **关于【${type}】，姐姐帮为你抽取决定：**\n> ✨ **${result}** ✨`, ephemeral: true });
    }
    if (commandName === '灵感摇号') {
        const rawOptions = interaction.options.getString('选项');
        const list = rawOptions.trim().split(/\s+/);
        if (list.length === 0) return interaction.reply({ content: '(⁠・⁠_⁠・⁠;⁠) 请提供至少一个选项，用空格分开哦！', ephemeral: true });
        const picked = list[Math.floor(Math.random() * list.length)];
        return interaction.reply({ content: `(⁠/⁠^⁠-⁠^⁠/⁠) **摇号完成！从 [${list.join(', ')}] 中抽中了：**\n> ✨ **${picked}** ✨`, ephemeral: true });
    }
    if (commandName === '掷骰') {
        const max = interaction.options.getInteger('最大值') || 6;
        if (max < 1) return interaction.reply({ content: '(⁠・⁠_⁠・⁠;⁠) 最大值必须大于 0 哦！', ephemeral: true });
        const num = Math.floor(Math.random() * max) + 1;
        return interaction.reply({ content: `(⁠/⁠^⁠-⁠^⁠/⁠) 🎲 **掷骰结果 (1-${max})：** **${num}**`, ephemeral: true });
    }

    // 纪念日
    if (commandName === '设置纪念日' || commandName === '查看纪念日') {
        if (!checkChannelRestriction(interaction, '纪念日')) return;

        if (commandName === '设置纪念日') {
            const name = interaction.options.getString('名称');
            const date = interaction.options.getString('日期');
            const advanceDays = interaction.options.getInteger('提前天数') || 3;
            db.anniversaries.push({ name, date, advanceDays });
            saveDB();
            return interaction.reply({ content: `(⁠*⁠^⁠-⁠^⁠*⁠) 已记录纪念日 **【${name}】** (${date})！`, ephemeral: true });
        }
        if (commandName === '查看纪念日') {
            if (db.anniversaries.length === 0) return interaction.reply({ content: '(⁠*⁠^⁠-⁠^⁠*⁠) 目前还没有记录任何纪念日哦！', ephemeral: true });
            const list = db.anniversaries.map((x, i) => `${i + 1}. **${x.name}** (${x.date})`).join('\n');
            return interaction.reply({ content: `(⁠/⁠^⁠-⁠^⁠/⁠) **纪念日清单：**\n${list}`, ephemeral: true });
        }
    }

    // 便签
    if (commandName === '记便签' || commandName === '查看便签' || commandName === '删除便签') {
        if (commandName === '记便签') {
            const content = interaction.options.getString('内容');
            db.todos.push(content);
            saveDB();
            return interaction.reply({ content: `(⁠*⁠^⁠-⁠^⁠*⁠) 成功记下便签: **${content}**`, ephemeral: true });
        }
        if (commandName === '查看便签') {
            if (db.todos.length === 0) return interaction.reply({ content: '(⁠*⁠^⁠-⁠^⁠*⁠) 便签夹里空空如也~', ephemeral: true });
            const list = db.todos.map((x, i) => `${i + 1}. ${x}`).join('\n');
            return interaction.reply({ content: `(⁠/⁠^⁠-⁠^⁠/⁠) **当前便签清单：**\n${list}`, ephemeral: true });
        }
        if (commandName === '删除便签') {
            const index = interaction.options.getInteger('编号') - 1;
            if (index < 0 || index >= db.todos.length) return interaction.reply({ content: '(⁠・⁠_⁠・⁠;⁠) 输入的编号不存在哦！', ephemeral: true });
            const removed = db.todos.splice(index, 1);
            saveDB();
            return interaction.reply({ content: `(⁠*⁠^⁠-⁠^⁠*⁠) 已删除便签: **${removed[0]}**`, ephemeral: true });
        }
    }

    // 剪贴板
    if (commandName === '存剪贴板' || commandName === '搜剪贴板') {
        if (!checkChannelRestriction(interaction, '剪贴板')) return;

        if (commandName === '存剪贴板') {
            const content = interaction.options.getString('内容');
            db.clipboards.push({ content, date: new Date().toLocaleString() });
            saveDB();
            return interaction.reply({ content: `(⁠•⁠̀⁠ᴗ⁠•⁠́⁠)⁠و 已存入剪贴板档案库！`, ephemeral: true });
        }
        if (commandName === '搜剪贴板') {
            const keyword = interaction.options.getString('关键词');
            const results = db.clipboards.filter(x => x.content.includes(keyword));
            if (results.length === 0) return interaction.reply({ content: `(⁠・⁠_⁠・⁠;⁠) 未查找到包含关键词 [${keyword}] 的记录。`, ephemeral: true });
            const list = results.map((x, i) => `${i + 1}. [${x.date}] ${x.content}`).slice(0, 5).join('\n');
            return interaction.reply({ content: `(⁠/⁠^⁠-⁠^⁠/⁠) **剪贴板检索结果：**\n${list}`, ephemeral: true });
        }
    }

    // 碎碎念日记
    if (commandName === '写日记' || commandName === '随机日记' || commandName === '搜日记') {
        if (!checkChannelRestriction(interaction, '日记')) return;

        if (commandName === '写日记') {
            const content = interaction.options.getString('内容');
            db.diaries.push({ date: new Date().toISOString().slice(0, 10), content });
            saveDB();
            return interaction.reply({ content: `(⁠*⁠^⁠-⁠^⁠*⁠) 日记胶囊已封存！`, ephemeral: true });
        }
        if (commandName === '随机日记') {
            if (db.diaries.length === 0) return interaction.reply({ content: '(⁠・⁠_⁠・⁠;⁠) 还没有写过日记哦！', ephemeral: true });
            const item = db.diaries[Math.floor(Math.random() * db.diaries.length)];
            return interaction.reply({ content: `(⁠/⁠^⁠-⁠^⁠/⁠) **开启历史日记胶囊 [${item.date}]：**\n> ${item.content}`, ephemeral: true });
        }
    }

    // AI 待聊梗 / 灵感
    if (commandName === '抽灵感梗' || commandName === '搜灵感梗') {
        if (!checkChannelRestriction(interaction, '灵感梗')) return;

        if (commandName === '抽灵感梗') {
            if (!db.promptIdeas || db.promptIdeas.length === 0) return interaction.reply({ content: '(⁠・⁠_⁠・⁠;⁠) 梗库目前是空的哦！', ephemeral: true });
            const item = db.promptIdeas[Math.floor(Math.random() * db.promptIdeas.length)];
            return interaction.reply({ content: `(⁠/⁠^⁠-⁠^⁠/⁠) **为您抽取一个与 AI 互动灵感梗：**\n> ${item.content}`, ephemeral: true });
        }
        if (commandName === '搜灵感梗') {
            const kw = interaction.options.getString('关键词');
            const res = (db.promptIdeas || []).filter(x => x.content && x.content.includes(kw));
            if (res.length === 0) return interaction.reply({ content: `(⁠・⁠_⁠・⁠;⁠) 梗库中未找到包含 [${kw}] 的内容。`, ephemeral: true });
            const list = res.slice(0, 5).map((x, i) => `${i + 1}. ${x.content}`).join('\n');
            return interaction.reply({ content: `(⁠/⁠^⁠-⁠^⁠/⁠) **找到以下灵感梗（共 ${res.length} 条，展示前5条）：**\n${list}`, ephemeral: true });
        }
    }

    // 存/看回忆
    if (commandName === '存回忆' || commandName === '看回忆') {
        if (!checkChannelRestriction(interaction, '回忆录')) return;

        if (commandName === '存回忆') {
            const char = interaction.options.getString('角色');
            const content = interaction.options.getString('剧情');
            db.memories.push({ character: char, content, date: new Date().toISOString().slice(0, 10) });
            saveDB();
            return interaction.reply({ content: `(⁠*⁠^⁠-⁠^⁠*⁠) 已为您保存与角色 **【${char}】** 的名场面回忆！`, ephemeral: true });
        }
        if (commandName === '看回忆') {
            const char = interaction.options.getString('角色');
            let filtered = char ? db.memories.filter(x => x.character === char) : db.memories;
            if (filtered.length === 0) return interaction.reply({ content: `(⁠・⁠_⁠・⁠;⁠) 还没有记录过 ${char ? '角色【' + char + '】的' : ''}名场面回忆哦！`, ephemeral: true });
            const item = filtered[Math.floor(Math.random() * filtered.length)];
            return interaction.reply({ content: `(⁠/⁠^⁠-⁠^⁠/⁠) **重温名场面 [角色: ${item.character}] (${item.date})：**\n> ${item.content}`, ephemeral: true });
        }
    }

    // 私人资源档案馆
    if (commandName === '存资源' || commandName === '搜资源' || commandName === '抓取本帖资源') {
        if (!checkChannelRestriction(interaction, '资源库')) return;

        if (commandName === '存资源') {
            const name = interaction.options.getString('名称');
            const category = interaction.options.getString('分类');
            const author = interaction.options.getString('作者') || '未知/匿名';
            const link = interaction.options.getString('链接') || '无链接';
            const note = interaction.options.getString('备注') || '无备注';

            const item = { name, category, author, link, note, date: new Date().toISOString().slice(0, 10) };
            db.resources.push(item);
            saveDB();

            const embed = new EmbedBuilder()
                .setTitle(`🏛️ 资源入库成功: ${name}`)
                .setColor(0x00FF7F)
                .addFields(
                    { name: '🏷️ 分类', value: category, inline: true },
                    { name: '👤 作者', value: author, inline: true },
                    { name: '🔗 链接', value: link },
                    { name: '📝 备注', value: note }
                )
                .setFooter({ text: `录入时间: ${item.date}` });

            return interaction.reply({ embeds: [embed], ephemeral: true });
        }

        if (commandName === '搜资源') {
            const cat = interaction.options.getString('分类');
            const author = interaction.options.getString('作者');
            const kw = interaction.options.getString('关键词');

            let results = db.resources;

            if (cat) results = results.filter(x => x.category === cat);
            if (author) results = results.filter(x => x.author.toLowerCase().includes(author.toLowerCase()));
            if (kw) results = results.filter(x => x.name.includes(kw) || x.note.includes(kw));

            if (results.length === 0) return interaction.reply({ content: '(⁠・⁠_⁠・⁠;⁠) 未找到符合条件的资源记录哦！', ephemeral: true });

            const list = results.slice(0, 5).map((x, i) => 
                `**${i + 1}. [${x.category}] ${x.name}** (作者: ${x.author})\n> 🔗 链接: ${x.link}\n> 📝 备注: ${x.note}`
            ).join('\n\n');

            return interaction.reply({ content: `(⁠/⁠^⁠-⁠^⁠/⁠) **档案馆检索结果 (找到 ${results.length} 项，展示前5项)：**\n\n${list}`, ephemeral: true });
        }

        if (commandName === '抓取本帖资源') {
            if (!interaction.channel.isThread()) return interaction.reply({ content: '(⁠・⁠_⁠・⁠;⁠) 此指令必须在论坛帖子内使用哦！', ephemeral: true });

            await interaction.deferReply({ ephemeral: true });
            try {
                const firstMessage = await interaction.channel.fetchStarterMessage().catch(() => null);

                let extractedName = interaction.channel.name;
                let extractedAuthor = firstMessage ? firstMessage.author.username : '未知';
                let extractedContent = firstMessage ? firstMessage.content.slice(0, 100) : '无正文';
                let extractedFile = (firstMessage && firstMessage.attachments.size > 0) ? firstMessage.attachments.first().url : '本帖无附件';

                const embed = new EmbedBuilder()
                    .setTitle(`🔍 抓取本帖预览: ${extractedName}`)
                    .setColor(0x1E90FF)
                    .setDescription(`已被抓取！预览如下：\n> **帖主**: ${extractedAuthor}\n> **内容概览**: ${extractedContent}\n> **附件/文件**: ${extractedFile}`)
                    .setFooter({ text: '你可以直接使用 /存资源 将其录入资源档案馆！' });

                return interaction.editReply({ embeds: [embed] });
            } catch (e) {
                return interaction.editReply('(⁠;⁠´⁠_⁠_⁠`⁠) 抓取帖子信息失败，请确保 Bot 拥有读取该频道的权限。');
            }
        }
    }

    // 塔罗占卜
    if (commandName === '塔罗占卜' || commandName === '每日运势') {
        if (!checkChannelRestriction(interaction, '塔罗运势')) return;

        const card = TAROT_CARDS[Math.floor(Math.random() * TAROT_CARDS.length)];
        return interaction.reply({ content: `(⁠*⁠^⁠-⁠^⁠*⁠) **塔罗牌抽卡：**\n> 牌面：**【${card.name}】** (${card.position})\n> 牌意：${card.desc}`, ephemeral: true });
    }

    // 全社区备份
    if (commandName === '全社区备份') {
        await interaction.deferReply({ ephemeral: true });
        await autoBackupCommunity();
        return interaction.editReply('(⁠•⁠̀⁠ᴗ⁠•⁠́⁠)⁠و 全社区聊天历史与帖子已成功抓取，并直接覆盖更新提交至 GitHub 的 `community_backup.json` 文件！');
    }

    // 还原社区
    if (commandName === '还原社区') {
        await interaction.deferReply({ ephemeral: true });
        const backupData = await getBackupFromGitHub('community_backup.json');
        if (!backupData || !backupData.channels) {
            return interaction.editReply('(⁠;⁠´⁠_⁠_⁠`⁠) 无法从 GitHub 读取备份文件 `community_backup.json`，还原中断。');
        }

        const guild = interaction.guild;
        try {
            await interaction.editReply(`(⁠*⁠´⁠ω⁠｀⁠*⁠) 开始读取备份数据（备份时间: ${backupData.last_updated}），准备重建社区架构...`);

            for (const [chanName, chanData] of Object.entries(backupData.channels)) {
                let targetChannel = guild.channels.cache.find(c => c.name === chanName);
                if (!targetChannel) {
                    targetChannel = await guild.channels.create({
                        name: chanName,
                        type: chanData.type || ChannelType.GuildText
                    });
                }

                if (chanData.messages && chanData.messages.length > 0 && targetChannel.isTextBased()) {
                    for (const m of chanData.messages) {
                        const timeStr = new Date(m.time).toLocaleString();
                        await targetChannel.send(`📜 **[${timeStr}] ${m.author}**: ${m.content}`).catch(() => null);
                    }
                }

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

            return interaction.followUp({ content: '(⁠•⁠̀⁠ᴗ⁠•⁠́⁠)⁠و **社区结构与历史消息已成功从 GitHub 备份中全部重建还原！**', ephemeral: true });
        } catch (err) {
            console.error('还原社区出现异常:', err);
            return interaction.followUp({ content: '(⁠;⁠´⁠_⁠_⁠`⁠) 还原过程中发生错误，请检查机器人是否拥有管理频道的权限。', ephemeral: true });
        }
    }
}); // <--- 这里补上了闭合大括号！

// 防止 Render 报端口缺失的 HTTP 服务
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running smooth! (⁠•⁠̀⁠ᴗ⁠•⁠́⁠)⁠و');
}).listen(PORT, () => {
    console.log(`(⁠•⁠̀⁠ᴗ⁠•⁠́⁠)⁠و 伪装端口监听启动: ${PORT}`);
});

client.login(TOKEN);
