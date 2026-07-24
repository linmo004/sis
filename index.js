const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ]
});

// 从云端环境变量中读取 Token 和 ID
const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

// =================【配置参数】=================
// 1. 超过多长时间无人回复就自动顶帖？(单位：毫秒)
// 比如：23 小时 = 23 * 60 * 60 * 1000 毫秒
const INACTIVE_THRESHOLD = 23 * 60 * 60 * 1000; 

// 2. Bot 自动检查的频率 (单位：毫秒)
// 比如：每 1 小时检查一次 = 1 * 60 * 60 * 1000 毫秒
const CHECK_INTERVAL = 1 * 60 * 60 * 1000; 

// 3. 顶帖时发送的文本内容
const BUMP_MESSAGE_TEXT = '(⁠////⁠^⁠-⁠^⁠////⁠) 饱饱姐姐来顶帖啦，饱饱随心发不用担心找不到o';
// =============================================

// 用于记录每个帖子上次发送的防沉消息 ID
const lastBumpMessages = new Map();

// 注册斜杠指令 /回顶
const commands = [
    new SlashCommandBuilder()
        .setName('回顶')
        .setDescription('生成一个可直接回到帖子顶部的快速跳转按钮')
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);

client.once('ready', async () => {
    console.log(`(⁠•⁠̀⁠ᴗ⁠•⁠́⁠)⁠و 机器人已成功登录：${client.user.tag}`);
    
    // 注册指令
    try {
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        console.log('(⁠•⁠̀⁠ᴗ⁠•⁠́⁠)⁠و 斜杠指令注册成功！');
    } catch (error) {
        console.error('(⁠;⁠´⁠_⁠_⁠`⁠) 注册指令失败:', error);
    }

    // 启动定时防沉检测任务
    console.log('(⁠*⁠´⁠ω⁠｀⁠*⁠) 自动防沉顶帖服务已启动...');
    setInterval(checkAndBumpThreads, CHECK_INTERVAL);
});

// 核心功能：自动防沉检查逻辑
async function checkAndBumpThreads() {
    try {
        for (const guild of client.guilds.cache.values()) {
            const activeThreads = await guild.channels.fetchActiveThreads();
            const now = Date.now();

            for (const thread of activeThreads.threads.values()) {
                if (thread.locked) continue;

                const lastMessage = thread.lastMessageId 
                    ? await thread.messages.fetch(thread.lastMessageId).catch(() => null) 
                    : null;

                if (lastMessage) {
                    const lastMessageTime = lastMessage.createdTimestamp;

                    if (now - lastMessageTime > INACTIVE_THRESHOLD) {
                        // 1. 尝试删除上一次的旧顶帖消息
                        const oldBumpMsgId = lastBumpMessages.get(thread.id);
                        if (oldBumpMsgId) {
                            try {
                                const oldMsg = await thread.messages.fetch(oldBumpMsgId).catch(() => null);
                                if (oldMsg) {
                                    await oldMsg.delete();
                                    console.log(`(⁠╯⁠_⁠╰⁠) 已清理帖子 [${thread.name}] 的旧顶帖消息`);
                                }
                            } catch (err) {
                                console.error('删除旧消息失败:', err);
                            }
                        }

                        // 2. 发送新的顶帖消息
                        const newMsg = await thread.send(BUMP_MESSAGE_TEXT);
                        
                        // 3. 记录新消息 ID
                        lastBumpMessages.set(thread.id, newMsg.id);
                        console.log(`(⁠//⁠^⁠-⁠^⁠//⁠) 已成功为帖子 [${thread.name}] 发送防沉顶帖`);
                    }
                }
            }
        }
    } catch (error) {
        console.error('检查帖子时发生错误:', error);
    }
}

// 监听 /回顶 指令
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === '回顶') {
        if (!interaction.channel.isThread()) {
            return interaction.reply({ content: '(⁠・⁠_⁠・⁠;⁠) 这个指令只能在帖子（Thread）内部使用哦！', ephemeral: true });
        }

        const firstMessageId = interaction.channel.id;
        const guildId = interaction.guildId;
        const topMessageUrl = `https://discord.com/channels/${guildId}/${interaction.channel.id}/${firstMessageId}`;

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel('(^ - ^)/ 饱饱急急慢不要来~姐姐来啦 点击直达帖子顶部')
                .setStyle(ButtonStyle.Link)
                .setURL(topMessageUrl)
        );

        await interaction.reply({
            content: '(⁠*⁠^⁠-⁠^⁠*⁠) 摸摸饱饱 点击下方按钮即可快速返回帖子首条消息：',
            components: [row]
        });
    }
});

client.login(TOKEN);
