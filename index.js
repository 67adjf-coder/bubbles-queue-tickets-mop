const {
    Client,
    GatewayIntentBits,
    SlashCommandBuilder,
    REST,
    Routes,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    PermissionFlagsBits,
    ChannelType,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    MessageFlags,
    ActivityType
} = require('discord.js');
const express = require('express');
const QRCode = require('qrcode');
const axios = require('axios');
const Jimp = require('jimp');
const Tesseract = require('tesseract.js');
const discordTranscripts = require('discord-html-transcripts');
require('dotenv').config();

// ==========================================
// 0. CONFIGURATION & EXPRESS SETUP
// ==========================================
const app = express();
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => res.send('Combined Coastal Cart Bot is online.'));
app.get('/health', (req, res) => res.status(200).send('OK'));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Express] Web server bound and listening on port ${PORT}`);
});

const STAFF_ROLE_IDS = ['1507220913249325116', '1533372358755221566'];
const RESTRICTED_TICKET_ROLE_ID = '1557329338943283240'; // No-Vouch Role ID
const QUEUE_CHANNEL_ID = '1539239066049060974';
const TRANSCRIPT_CHANNEL_ID = '1507278726998524046';
const VOUCH_URL = 'https://discord.com/channels/1507214174084927498/1507271897962778706';
const BANNER_URL = 'https://cdn.discordapp.com/attachments/1553697060056866906/1554405328462938162/Coral_Reef_Sea_GIF_-_Coral_Reef_Sea_Ocean_-_Discover__Share_GIFs.gif?ex=6abf6745&is=6abe15c5&hm=7248fb3fe9a07a4857b393db5d6a767808fb7d12d910cd4e1bcd95281abb5a18';
const PASTEL_BLUE = 0xAEC6CF;

// Category IDs for Tickets
const ORDER_CATEGORY_ID = '1537390467921215498';
const REPORT_CATEGORY_ID = '1537434112951062598';
const OTHERS_CATEGORY_ID = '1555853722788302848';

// --- In-Memory Stores & Helpers ---
let queueCounter = 1;
const queueStore = new Map();
const ticketStore = new Map();

function isStaff(member) {
    if (!member || !member.roles) return false;
    return STAFF_ROLE_IDS.some(roleId => member.roles.cache.has(roleId));
}

// ==========================================
// CLIENT INITIALIZATION & COMMAND REGISTRATION
// ==========================================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ],
    ws: {
        properties: {
            os: 'linux',
            browser: 'discord.js',
            device: 'discord.js'
        }
    }
});

const commands = [
    new SlashCommandBuilder()
        .setName('queue-list')
        .setDescription('Create a new queue tracker for an order')
        .addUserOption(opt => opt.setName('buyer').setDescription('User who bought an item').setRequired(true))
        .addStringOption(opt => opt.setName('qty').setDescription('Quantity').setRequired(true))
        .addStringOption(opt => opt.setName('item').setDescription('Item name').setRequired(true))
        .addStringOption(opt => opt.setName('info').setDescription('Item info (game name, via plus or payout, etc.)').setRequired(true))
        .addStringOption(opt => opt.setName('price').setDescription('Price paid').setRequired(true))
        .addStringOption(opt => opt.setName('payment').setDescription('Mode of payment').setRequired(true)),

    new SlashCommandBuilder()
        .setName('ticket-setup')
        .setDescription('Sends the main ticket setup panel'),

    new SlashCommandBuilder()
        .setName('mop')
        .setDescription('Generate mode of payment details for a buyer')
        .addNumberOption(opt => opt.setName('amount').setDescription('Amount the buyer needs to pay').setRequired(true))
].map(cmd => cmd.toJSON());

client.once('ready', async () => {
    console.log(`[Discord Gateway] Logged in as ${client.user.tag}!`);

    client.user.setPresence({
        activities: [{ name: 'your tickets!', type: ActivityType.Watching }],
        status: 'online'
    });

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('[Slash Commands] Registered all slash commands globally!');
    } catch (err) {
        console.error('[Slash Commands Error]', err);
    }
});

// ==========================================
// MAIN INTERACTION DISPATCHER
// ==========================================
client.on('interactionCreate', async (interaction) => {
    try {
        // --- QUEUE MODULE ---
        if (interaction.isChatInputCommand() && interaction.commandName === 'queue-list') {
            return handleQueueCommand(interaction);
        }
        if (interaction.isStringSelectMenu() && interaction.customId.startsWith('queue_menu_')) {
            return handleQueueMenu(interaction);
        }

        // --- TICKET MODULE ---
        if (interaction.isChatInputCommand() && interaction.commandName === 'ticket-setup') {
            return handleTicketSetupCommand(interaction);
        }
        if (interaction.isButton() && ['btn_order', 'btn_report', 'btn_others', 'claim_ticket', 'close_ticket'].includes(interaction.customId)) {
            return handleTicketButtons(interaction);
        }
        if (interaction.isStringSelectMenu() && interaction.customId === 'menu_bobaks') {
            return handleBobaksMenu(interaction);
        }
        if (interaction.isButton() && ['btn_bobaks', 'btn_topups', 'btn_dc_items', 'btn_premiums', 'btn_report_action'].includes(interaction.customId)) {
            return handleOrderSubButtons(interaction);
        }
        if (interaction.isModalSubmit() && [
            'modal_gamepass_ct', 'modal_viaplus_rush', 'modal_ingame_gifting', 'modal_viaplus_wtw', 'modal_group_payout',
            'modal_topups', 'modal_dc_items', 'modal_premiums', 'modal_report', 'modal_others', 'modal_close_reason'
        ].includes(interaction.customId)) {
            return handleTicketModals(interaction);
        }

        // --- MOP MODULE ---
        if (interaction.isChatInputCommand() && interaction.commandName === 'mop') {
            return handleMopCommand(interaction);
        }
        if (interaction.isButton() && (interaction.customId.startsWith('proceed_payment_') || interaction.customId.startsWith('mop_select_') || interaction.customId.startsWith('copy_'))) {
            return handleMopButtons(interaction);
        }
        if (interaction.isModalSubmit() && interaction.customId.startsWith('tip_modal_')) {
            return handleMopModals(interaction);
        }
    } catch (err) {
        console.error('Unhandled interaction error:', err);
    }
});

// ==========================================
// RECEIPT AUTO-READER (OCR) MODULE
// ==========================================
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const isBotMentioned = message.mentions.has(client.user.id);
    const attachment = message.attachments.first();

    if (isBotMentioned && attachment && attachment.contentType?.startsWith('image/')) {
        const loadingMsg = await message.reply('🔍 Scanning your receipt, please wait...');

        try {
            const response = await axios.get(attachment.url, { responseType: 'arraybuffer' });
            const inputBuffer = Buffer.from(response.data);

            const image = await Jimp.read(inputBuffer);
            image.greyscale().contrast(0.2).resize(1000, Jimp.AUTO);
            const processedBuffer = await image.getBufferAsync(Jimp.MIME_PNG);

            const { data: { text } } = await Tesseract.recognize(processedBuffer, 'eng');

            const refPatterns = [
                /(?:Ref\s*No\.|Reference\s*No\.|Ref\.|Transaction\s*No\.|Txn\s*ID|Control\s*No\.)\s*[:#-]?\s*([0-9\s]{9,20})/i,
                /\b00\d{10,12}\b/,
                /\b\d{13}\b/,
                /\b\d{4}\s?\d{3}\s?\d{6}\b/,
                /\b\d{4}\s?\d{4}\s?\d{4}\b/
            ];

            const amountPatterns = [
                /(?:Total\s*Amount\s*Sent|Amount|Total|Paid)\s*[:#-]?\s*(?:PHP|P|₱)?\s*([\d,]+\.\d{2})/i,
                /(?:PHP|P|₱)\s*([\d,]+\.\d{2})/i,
                /\b([\d,]+\.\d{2})\b/
            ];

            let extractedRef = null;
            for (const pattern of refPatterns) {
                const match = text.match(pattern);
                if (match) {
                    extractedRef = (match[1] || match[0]).replace(/\s+/g, '').trim();
                    break;
                }
            }

            let extractedAmount = null;
            for (const pattern of amountPatterns) {
                const match = text.match(pattern);
                if (match) {
                    extractedAmount = (match[1] || match[0]).trim();
                    break;
                }
            }

            const receiptEmbed = new EmbedBuilder()
                .setColor(PASTEL_BLUE)
                .setTitle('🧾 Receipt Details Detected')
                .addFields(
                    { name: 'Reference Number', value: extractedRef ? `\`${extractedRef}\`` : '⚠️ *Not detected clearly*', inline: true },
                    { name: 'Amount Paid', value: extractedAmount ? `₱${extractedAmount}` : '⚠️ *Not detected clearly*', inline: true },
                    { name: 'Payer / Mentioned', value: `${message.author}`, inline: false }
                )
                .setFooter({ text: 'Please wait for staff to verify your payment.' })
                .setTimestamp();

            await loadingMsg.edit({ content: '✅ Receipt processed!', embeds: [receiptEmbed] });

        } catch (error) {
            console.error('OCR Processing Error details:', error.message || error);
            await loadingMsg.edit('❌ Failed to read the receipt image. Please verify manually.');
        }
    }
});


// ==========================================
// SECTION 1: QUEUE SYSTEM MODULE (/queue-list)
// ==========================================
function buildQueueEmbed(guildId, ticketChannelId, queueNum, buyerId, qty, item, info, payment, price, staffId, statusText) {
    const description = `
_ _
-# _ _     <:flower:1560691740456001659>     ** 𑂘__oft__  𝒲hιspᧉrs **  **. . .**   \` ₍ᐢ..ᐢ₎⁺ \`
┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈
-# _ _         cɑtᧉrᧉd wιth ℓovᧉ, <@${staffId}> <:zz_blueheart3:1555584821529546752> 

-# _ _          <:glow_dots:1560696020852019310> <@${buyerId}>  ɑt  <#${ticketChannelId}>
-# _ _          <:glow_dots:1560696020852019310> \` # \` ${qty}     ~~         ~~   ${item}
-# _ _          <:glow_dots:1560696020852019310>  ${info}     <:hart:1555857231814328331>    ₱\` ${price} \` vιɑ ( ${payment} )

-# _ _                     your ιtᧉm ιs:  **${statusText}**
    `;

    return new EmbedBuilder()
        .setColor(PASTEL_BLUE)
        .setDescription(description)
        .setTimestamp();
}

async function handleQueueCommand(interaction) {
    if (!isStaff(interaction.member)) {
        return interaction.reply({ content: 'You do not have permission to use this command.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const buyer = interaction.options.getUser('buyer');
    const qty = interaction.options.getString('qty');
    const item = interaction.options.getString('item');
    const info = interaction.options.getString('info');
    const price = interaction.options.getString('price');
    const payment = interaction.options.getString('payment');

    const ticketChannelId = interaction.channelId;
    const staffUser = interaction.user;
    const currentQueueNum = queueCounter++;

    queueStore.set(ticketChannelId, {
        queueNum: currentQueueNum,
        buyerId: buyer.id,
        qty,
        item,
        info,
        payment,
        price,
        staffId: staffUser.id
    });

    const localEmbed = new EmbedBuilder()
        .setColor(PASTEL_BLUE)
        .setDescription(`
_ _
-# \\`    order  tracker \ ` ~~                                               ~~
-# _ _  **nb & dekors**     \` \`    mto 
-# _ _  **gɑme topups**    \` \`    mins-hrs 
-# _ _  **roblx bobɑks**    \` \`    mins-days 
~~                                               ~~ trɑck your order(s) [here](https://discord.com/channels/${interaction.guildId}/${QUEUE_CHANNEL_ID}) ! 𓆉 no rushing! pls, be patient. ~~                                               ~~ _ _
        `)
        .setTimestamp();

    await interaction.channel.send({ embeds: [localEmbed] });
    await interaction.editReply({ content: 'Queue logged successfully!' });

    const queueEmbed = buildQueueEmbed(
        interaction.guildId,
        ticketChannelId,
        currentQueueNum,
        buyer.id,
        qty,
        item,
        info,
        payment,
        price,
        staffUser.id,
        'in-quᧉuᧉ'
    );

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`queue_menu_${ticketChannelId}`)
        .setPlaceholder('select queue status...')
        .addOptions([
            {
                label: 'noted',
                description: 'Set status to noted by ownie',
                value: 'noted',
                emoji: '🐚'
            },
            {
                label: 'processing',
                description: 'Set status to now processing',
                value: 'proc',
                emoji: '🫧'
            },
            {
                label: 'completed',
                description: 'Set status to done & delivered',
                value: 'comp',
                emoji: '🐋'
            }
        ]);

    const row = new ActionRowBuilder().addComponents(selectMenu);

    const queueChannel = await client.channels.fetch(QUEUE_CHANNEL_ID).catch(() => null);
    if (queueChannel) {
        await queueChannel.send({ embeds: [queueEmbed], components: [row] });
    }
}

async function handleQueueMenu(interaction) {
    if (!isStaff(interaction.member)) {
        return interaction.reply({ content: 'Only staff can update queue status.', flags: MessageFlags.Ephemeral });
    }

    const customId = interaction.customId;
    const ticketChannelId = customId.replace('queue_menu_', '');
    const action = interaction.values[0]; // 'noted', 'proc', or 'comp'

    let data = queueStore.get(ticketChannelId);
    if (!data) {
        const embed = interaction.message.embeds[0];
        if (!embed || !embed.description) return;

        const buyerMatch = embed.description.match(/<@(\d+)>/);
        const staffMatch = embed.description.match(/cɑtᧉrᧉd wιth ℓovᧉ, <@(\d+)>/);

        data = {
            queueNum: '?',
            buyerId: buyerMatch ? buyerMatch[1] : interaction.user.id,
            qty: '1',
            item: 'Item',
            info: 'Info',
            payment: 'Payment',
            price: 'Price',
            staffId: staffMatch ? staffMatch[1] : interaction.user.id
        };
    }

    let statusLabel = 'in-quᧉuᧉ';
    if (action === 'noted') statusLabel = 'notᧉd by owniᧉ';
    else if (action === 'proc') statusLabel = 'now procᧉssing';
    else if (action === 'comp') statusLabel = 'donᧉ & dᧉlivᧉrᧉd';

    const updatedEmbed = buildQueueEmbed(
        interaction.guildId,
        ticketChannelId,
        data.queueNum,
        data.buyerId,
        data.qty,
        data.item,
        data.info,
        data.payment,
        data.price,
        interaction.user.id,
        statusLabel
    );

    await interaction.update({ embeds: [updatedEmbed], components: interaction.message.components });

    try {
        const ticketChannel = await client.channels.fetch(ticketChannelId).catch(() => null);
        if (ticketChannel) {
            if (action === 'proc') {
                const processingEmbed = new EmbedBuilder()
                    .setColor(PASTEL_BLUE)
                    .setDescription(`
_ _
            **ℓovᧉ  dᧉɑrly,**  <@${data.buyerId}>  !  <a:a009_bluebow1491899840941129808:1555584862511956129>  
          
           thᧉ __tidᧉs__ ɑrᧉ **ɑlignᧉd** . . . ɑnd
       your order is now being __***processed.***__

           thɑnk you for wɑiting pɑtiently,
          pleɑse do not rush peɑrl-keepers
                    `)
                    .setTimestamp();

                await ticketChannel.send({
                    content: `<@${data.buyerId}>`,
                    embeds: [processingEmbed]
                });
            } 
            else if (action === 'comp') {
                const completionEmbed = new EmbedBuilder()
                    .setColor(PASTEL_BLUE)
                    .setDescription(`
_ _
            **ℓovᧉ  dᧉɑrly,**  <@${data.buyerId}>  !  <a:a009_bluebow1491899840941129808:1555584862511956129>  
          
           thᧉ __tidᧉs__ ɑrᧉ **ɑlignᧉd** . . . ɑnd
       your order is now __***sent & delivered.***__

           thɑnk you for wɑiting pɑtiently,
          pleɑse do vouch the peɑrl-keepers
                    `)
                    .setTimestamp();

                const vouchButtonRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setLabel('vouch here').setStyle(ButtonStyle.Link).setURL(VOUCH_URL)
                );

                await ticketChannel.send({
                    content: `<@${data.buyerId}>`,
                    embeds: [completionEmbed],
                    components: [vouchButtonRow]
                });
            }
        }
    } catch (err) {
        console.error('Could not send notification message to ticket channel:', err.message || err);
    }
}


// ==========================================
// SECTION 2: TICKET SYSTEM MODULE (/ticket-setup)
// ==========================================
async function handleTicketSetupCommand(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // 1. Top Text Embed
    const textEmbed = new EmbedBuilder()
        .setColor(PASTEL_BLUE)
        .setDescription(`
_ _
         𓈒   ୭ৎ         tιckᧉttᧉ     :    boothᧉ     ⛲ᨯ    
-# _ _                    **reɑd notes before creɑting ɑ tix**

-# _ _          pɑyment first is required to purchɑse 
-# _ _          **do not** creɑte  ɑ  ticket just to ɑsk us!
-# _ _          iɑ tickette for 4 hours = closed + wɑrn
-# _ _          **do not** troll just to try d buttons = ban
-# _ _          use buttons ɑccordingly ɑnd correctly
        `);

    // 2. GIF Embed
    const gifEmbed = new EmbedBuilder()
        .setColor(PASTEL_BLUE)
        .setImage('https://cdn.discordapp.com/attachments/1560207522521022494/1560703160811651254/tumblr_nabwdbnlD01qg67clo1_500_gif_500200.gif?ex=6ad3ad96&is=6ad25c16&hm=a4d79aa4ff23e9381c132e6458f009118ceb839a1b476fb166116c0734526542');

    // Send Message 1: Text Header
    await interaction.channel.send({ embeds: [textEmbed] });

    // Send Message 2: Container Box (type: 17) holding the action row buttons INSIDE the container
    await interaction.channel.send({
        flags: 32768, // IS_COMPONENTS_V2 flag
        components: [
            {
                type: 17, // Container component
                accent_color: PASTEL_BLUE,
                components: [
                    {
                        type: 1, // Action Row inside the container
                        components: [
                            {
                                type: 2,
                                style: 2, // Secondary / Gray Button
                                custom_id: 'btn_order',
                                label: 'order'
                            },
                            {
                                type: 2,
                                style: 2,
                                custom_id: 'btn_report',
                                label: 'report'
                            },
                            {
                                type: 2,
                                style: 2,
                                custom_id: 'btn_others',
                                label: 'other'
                            }
                        ]
                    }
                ]
            }
        ]
    });

    // Send Message 3: Bottom GIF Embed
    await interaction.channel.send({ embeds: [gifEmbed] });

    await interaction.editReply({ content: 'Ticket setup panel sent!' });
}

    if (customId === 'btn_report') {
        const reportEmbed = new EmbedBuilder()
            .setColor(PASTEL_BLUE)
            .setDescription(
`_ _
          <a:butterflynablue:1555246416115535903>  **report**  __αwαy__  !
> click on the button below to report
> αnswer αll truthfully & completely !
-# **note**: this is αn αutomαted system. do
-# wait for stαffs to αssist you in this mαtter.
_ _`
            )
            .setImage(BANNER_URL);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('btn_report_action').setLabel('report').setStyle(ButtonStyle.Secondary)
        );

        return await interaction.reply({ embeds: [reportEmbed], components: [row], flags: MessageFlags.Ephemeral });
    }

    if (customId === 'btn_others') {
        const modal = new ModalBuilder().setCustomId('modal_others').setTitle('Others Ticket Form');
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('reason for opening a ticket:').setPlaceholder('application, partnership, etc.').setStyle(TextInputStyle.Paragraph).setRequired(true))
        );
        return await interaction.showModal(modal);
    }

    if (customId === 'claim_ticket') {
        if (!isStaff(interaction.member)) {
            return interaction.reply({ content: 'Only staff can claim tickets.', flags: MessageFlags.Ephemeral });
        }

        const ticketData = ticketStore.get(interaction.channelId) || {};
        ticketData.claimedByStaffId = interaction.user.id;
        ticketStore.set(interaction.channelId, ticketData);

        const existingRow = interaction.message.components[0];
        const disabledRow = new ActionRowBuilder().addComponents(
            ButtonBuilder.from(existingRow.components[0]).setDisabled(true),
            ButtonBuilder.from(existingRow.components[1])
        );

        await interaction.update({ components: [disabledRow] });
        await interaction.channel.send(`tickette will be cαtered by: ${interaction.user}`);
        return;
    }

    if (customId === 'close_ticket') {
        if (!isStaff(interaction.member)) {
            return interaction.reply({ content: 'Only staff can close tickets.', flags: MessageFlags.Ephemeral });
        }

        const modal = new ModalBuilder().setCustomId('modal_close_reason').setTitle('Close Ticket');
        const reasonInput = new TextInputBuilder()
            .setCustomId('close_reason')
            .setLabel('Reason')
            .setPlaceholder('Enter the reason for closing this ticket...')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
        return await interaction.showModal(modal);
    }
}

async function handleOrderSubButtons(interaction) {
    const customId = interaction.customId;

    if (customId === 'btn_bobaks') {
        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('menu_bobaks')
            .setPlaceholder('Select bobaks option...')
            .addOptions(
                new StringSelectMenuOptionBuilder().setValue('gamepass_ct').setLabel('gαmepαss ct'),
                new StringSelectMenuOptionBuilder().setValue('viaplus_rush').setLabel('viaplus ( rush )'),
                new StringSelectMenuOptionBuilder().setValue('ingame_gifting').setLabel('in-gαme gifting'),
                new StringSelectMenuOptionBuilder().setValue('viaplus_wtw').setLabel('viaplus ( wtw )'),
                new StringSelectMenuOptionBuilder().setValue('group_payout').setLabel('group pαyout')
            );

        const row = new ActionRowBuilder().addComponents(selectMenu);
        return await interaction.reply({ content: 'Please select from the menu below:', components: [row], flags: MessageFlags.Ephemeral });
    }

    if (customId === 'btn_topups') {
        const modal = new ModalBuilder().setCustomId('modal_topups').setTitle('Topups Form');
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('game_name').setLabel('gαme nαme:').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('order_name').setLabel('order nαme:').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ingame_details').setLabel('in-gαme detαils: ( user id, server, etc. )').setStyle(TextInputStyle.Paragraph).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('quantity').setLabel('quαntity:').setStyle(TextInputStyle.Short).setRequired(true))
        );
        return await interaction.showModal(modal);
    }

    if (customId === 'btn_dc_items') {
        const modal = new ModalBuilder().setCustomId('modal_dc_items').setTitle('DC Items Form');
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('item_name').setLabel('item nαme:').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('gift_link').setLabel('gift link / login:').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('quantity').setLabel('quαntity:').setStyle(TextInputStyle.Short).setRequired(true))
        );
        return await interaction.showModal(modal);
    }

    if (customId === 'btn_premiums') {
        const modal = new ModalBuilder().setCustomId('modal_premiums').setTitle('Premiums Form');
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('item_name').setLabel('item nαme:').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('subscription').setLabel('subscription: ( months, yrs, days, etc. )').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('quantity').setLabel('quαntity:').setStyle(TextInputStyle.Short).setRequired(true))
        );
        return await interaction.showModal(modal);
    }

    if (customId === 'btn_report_action') {
        const modal = new ModalBuilder().setCustomId('modal_report').setTitle('Report Form');
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('dc_username').setLabel('dc username').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('report_reason').setLabel('what do u want to report?').setStyle(TextInputStyle.Paragraph).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('vouch_link').setLabel('vouch link ( put n/a if not applicable )').setStyle(TextInputStyle.Short).setRequired(true))
        );
        return await interaction.showModal(modal);
    }
}

async function handleBobaksMenu(interaction) {
    const val = interaction.values[0];

    if (val === 'gamepass_ct') {
        const modal = new ModalBuilder().setCustomId('modal_gamepass_ct').setTitle('Gamepass CT Form');
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('roblox_username').setLabel('rσblσx usernαme').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('gamepass_link').setLabel('gαmepαss link').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('amount').setLabel('αmount to purchαse').setStyle(TextInputStyle.Short).setRequired(true))
        );
        return await interaction.showModal(modal);
    }

    if (val === 'viaplus_rush') {
        const modal = new ModalBuilder().setCustomId('modal_viaplus_rush').setTitle('Via Plus (Rush) Form');
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('roblox_username').setLabel('rσblσx usernαme:').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('display_name').setLabel('displαy nαme:').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('amount').setLabel('αmount:').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('two_fa').setLabel('2fa enabled? [yes/no]').setStyle(TextInputStyle.Short).setRequired(true))
        );
        return await interaction.showModal(modal);
    }

    if (val === 'ingame_gifting') {
        const modal = new ModalBuilder().setCustomId('modal_ingame_gifting').setTitle('In-Game Gifting Form');
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('roblox_username').setLabel('rσblσx usernαme:').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('display_name').setLabel('displαy nαme:').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('amount').setLabel('αmount:').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('game_details').setLabel('gαme nαme & private server link:').setStyle(TextInputStyle.Paragraph).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('lvl_req').setLabel('lvl requirements? [yes/no]').setStyle(TextInputStyle.Short).setRequired(true))
        );
        return await interaction.showModal(modal);
    }

    if (val === 'viaplus_wtw') {
        const modal = new ModalBuilder().setCustomId('modal_viaplus_wtw').setTitle('Via Plus (WTW) Form');
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('roblox_username').setLabel('rσblσx usernαme:').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('display_name').setLabel('displαy nαme:').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('amount').setLabel('αmount:').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('two_fa').setLabel('2fa enabled? [yes/no]').setStyle(TextInputStyle.Short).setRequired(true))
        );
        return await interaction.showModal(modal);
    }

    if (val === 'group_payout') {
        const modal = new ModalBuilder().setCustomId('modal_group_payout').setTitle('Group Payout Form');
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('roblox_username').setLabel('rσblσx usernαme:').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('display_name').setLabel('displαy nαme:').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('amount').setLabel('αmount:').setStyle(TextInputStyle.Short).setRequired(true))
        );
        return await interaction.showModal(modal);
    }
}

async function handleTicketModals(interaction) {
    const customId = interaction.customId;

    if (customId === 'modal_close_reason') {
        if (!isStaff(interaction.member)) {
            return interaction.reply({ content: 'Only staff can close tickets.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const closeReason = interaction.fields.getTextInputValue('close_reason');
        const channel = interaction.channel;

        try {
            const transcript = await discordTranscripts.createTranscript(channel, {
                limit: -1,
                returnType: 'attachment',
                filename: `transcript-${channel.name}.html`,
                saveImages: true,
                poweredBy: false
            });

            const transcriptChannel = await client.channels.fetch(TRANSCRIPT_CHANNEL_ID).catch(() => null);
            if (transcriptChannel) {
                const closeEmbed = new EmbedBuilder()
                    .setColor(PASTEL_BLUE)
                    .setTitle('🔒 Ticket Closed')
                    .addFields(
                        { name: 'Ticket Name', value: `#${channel.name}`, inline: true },
                        { name: 'Closed By', value: `${interaction.user}`, inline: true },
                        { name: 'Reason', value: closeReason, inline: false }
                    )
                    .setTimestamp();

                await transcriptChannel.send({ embeds: [closeEmbed], files: [transcript] });
            }
        } catch (err) {
            console.error('Failed to generate transcript:', err);
        }

        await interaction.editReply({ content: 'Closing ticket and generating transcript...' });
        setTimeout(() => channel.delete().catch(() => {}), 3000);
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const usernameSanitized = interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '');
    let channelPrefix = 'order';
    let categoryId = ORDER_CATEGORY_ID;

    if (customId === 'modal_report') {
        channelPrefix = 'report';
        categoryId = REPORT_CATEGORY_ID;
    } else if (customId === 'modal_others') {
        channelPrefix = 'other';
        categoryId = OTHERS_CATEGORY_ID;
    }

    const ticketChannel = await interaction.guild.channels.create({
        name: `${channelPrefix}-${usernameSanitized}`,
        type: ChannelType.GuildText,
        parent: categoryId,
        permissionOverwrites: [
            { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
            ...STAFF_ROLE_IDS.map(roleId => ({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] }))
        ]
    });

    const fieldsData = interaction.fields.fields.map(f => `> **${f.customId.replace(/_/g, ' ')}:**${f.value}`).join('\n');

    const welcomeEmbed = new EmbedBuilder()
        .setColor(PASTEL_BLUE)
        .setDescription(
`_ _
# _ _     ticket opened by ${interaction.user} <:butterfly:1554370425587245066>
_ _
thank you for opening a ticket! please wait patiently for our staff to assist you.
_ _
### Form Details:
${fieldsData}
_ _`
        )
        .setImage(BANNER_URL)
        .setTimestamp();

    const controlRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('claim_ticket').setLabel('claim ticket').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('close_ticket').setLabel('close ticket').setStyle(ButtonStyle.Danger)
    );

    await ticketChannel.send({ content: `${interaction.user} <@&${STAFF_ROLE_IDS[0]}>`, embeds: [welcomeEmbed], components: [controlRow] });
    ticketStore.set(ticketChannel.id, { ownerId: interaction.user.id });

    await interaction.editReply({ content: `Your ticket has been created! Head over to <#${ticketChannel.id}>` });
}


// ==========================================
// SECTION 3: MODE OF PAYMENT MODULE (/mop)
// ==========================================
async function handleMopCommand(interaction) {
    if (!isStaff(interaction.member)) {
        return interaction.reply({ content: 'You do not have permission to use this command.', flags: MessageFlags.Ephemeral });
    }

    const amount = interaction.options.getNumber('amount');

    const mopEmbed = new EmbedBuilder()
        .setColor(PASTEL_BLUE)
        .setDescription(
`_ _
# _ _     mode of p**ay**ment <:butterfly:1554370425587245066>
_ _
total amount to pay: \` ₱${amount.toFixed(2)} \`
please choose your preferred payment method below:
_ _`
        )
        .setImage(BANNER_URL)
        .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`mop_select_gcash_${amount}`).setLabel('GCash').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`mop_select_maya_${amount}`).setLabel('Maya').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`mop_select_seabank_${amount}`).setLabel('SeaBank').setStyle(ButtonStyle.Secondary)
    );

    await interaction.reply({ embeds: [mopEmbed], components: [row] });
}

async function handleMopButtons(interaction) {
    const customId = interaction.customId;

    if (customId.startsWith('mop_select_')) {
        const [, , method, amountStr] = customId.split('_');
        const amount = parseFloat(amountStr);

        let accountNumber = '09123456789';
        let accountName = 'Coastal Cart Official';

        if (method === 'maya') accountNumber = '09987654321';
        if (method === 'seabank') accountNumber = '123456789012';

        const paymentEmbed = new EmbedBuilder()
            .setColor(PASTEL_BLUE)
            .setDescription(
`_ _
# _ _     payment details (${method.toUpperCase()})
_ _
> **Account Name:** \`${accountName}\`
> **Account Number:** \`${accountNumber}\`
> **Amount:** \` ₱${amount.toFixed(2)} \`
_ _
-# please send your payment and drop the receipt here with a mention of the bot!
_ _`
            )
            .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`copy_${accountNumber}`).setLabel('Copy Account Number').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`tip_modal_trigger_${amount}`).setLabel('Add Tip').setStyle(ButtonStyle.Success)
        );

        return await interaction.reply({ embeds: [paymentEmbed], components: [row], flags: MessageFlags.Ephemeral });
    }

    if (customId.startsWith('copy_')) {
        const accNum = customId.replace('copy_', '');
        return await interaction.reply({ content: `Copied account number: \`${accNum}\``, flags: MessageFlags.Ephemeral });
    }

    if (customId.startsWith('tip_modal_trigger_')) {
        const amount = customId.replace('tip_modal_trigger_', '');
        const modal = new ModalBuilder().setCustomId(`tip_modal_${amount}`).setTitle('Add Tip Amount');
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tip_amount').setLabel('Tip Amount (₱):').setStyle(TextInputStyle.Short).setRequired(true))
        );
        return await interaction.showModal(modal);
    }
}

async function handleMopModals(interaction) {
    if (interaction.customId.startsWith('tip_modal_')) {
        const baseAmount = parseFloat(interaction.customId.replace('tip_modal_', ''));
        const tipInput = parseFloat(interaction.fields.getTextInputValue('tip_amount')) || 0;
        const total = baseAmount + tipInput;

        return await interaction.reply({ content: `✅ Tip added successfully! New total amount to pay: \` ₱${total.toFixed(2)} \``, flags: MessageFlags.Ephemeral });
    }
}

client.login(process.env.DISCORD_TOKEN);
