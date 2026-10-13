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
    MessageFlags
} = require('discord.js');
const express = require('express');
const QRCode = require('qrcode');
const axios = require('axios');
const Jimp = require('jimp');
const Tesseract = require('tesseract.js');
const discordTranscripts = require('discord-html-transcripts');
require('dotenv').config();

// ==========================================
// CONFIGURATION & SETUP
// ==========================================
const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Combined Coastal Cart Bot is online.'));
app.listen(PORT, '0.0.0.0', () => console.log(`Web server listening on port ${PORT}`));

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

function getGMT8Time() {
    return new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Manila',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    }).format(new Date());
}

function isStaff(member) {
    if (!member || !member.roles) return false;
    return STAFF_ROLE_IDS.some(roleId => member.roles.cache.has(roleId));
}

// ==========================================
// SLASH COMMAND DEFINITIONS & REGISTRATION
// ==========================================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

const commands = [
    new SlashCommandBuilder()
        .setName('queue-list')
        .setDescription('Create a new queue tracker for an order')
        .addUserOption(opt => opt.setName('buyer').setDescription('Select the buyer').setRequired(true))
        .addStringOption(opt => opt.setName('item').setDescription('Item bought').setRequired(true))
        .addStringOption(opt => opt.setName('info').setDescription('Item info').setRequired(true))
        .addStringOption(opt => opt.setName('payment').setDescription('Payment method').setRequired(true))
        .addStringOption(opt => opt.setName('price').setDescription('Price paid').setRequired(true)),

    new SlashCommandBuilder()
        .setName('ticket-setup')
        .setDescription('Sends the main ticket setup panel'),

    new SlashCommandBuilder()
        .setName('mop')
        .setDescription('Generate mode of payment details for a buyer')
        .addNumberOption(opt => opt.setName('amount').setDescription('Amount the buyer needs to pay').setRequired(true))
].map(cmd => cmd.toJSON());

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('Successfully registered all slash commands globally!');
    } catch (err) {
        console.error('Error registering slash commands:', err);
    }
});

// ==========================================
// MAIN INTERACTION DISPATCHER
// ==========================================
client.on('interactionCreate', async (interaction) => {

    // --- 1. QUEUE COMMAND MODULE ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'queue-list') {
        return handleQueueCommand(interaction);
    }
    if (interaction.isButton() && interaction.customId.startsWith('queue_')) {
        return handleQueueButtons(interaction);
    }

    // --- 2. TICKET SETUP MODULE ---
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

    // --- 3. MODE OF PAYMENT (MOP) MODULE ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'mop') {
        return handleMopCommand(interaction);
    }
    if (interaction.isButton() && (interaction.customId.startsWith('proceed_payment_') || interaction.customId.startsWith('mop_select_') || interaction.customId.startsWith('copy_'))) {
        return handleMopButtons(interaction);
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('tip_modal_')) {
        return handleMopModals(interaction);
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
// MODULE 1: QUEUE SYSTEM FUNCTIONS
// ==========================================
function buildQueueEmbed(guildId, ticketChannelId, queueNum, buyerId, item, info, payment, price, staffId, statusText) {
    const description = 
`_ _
     𓂃 𓈒𓏸‪‪ 𓇼    [ **tid**__a__**l** **w**~~a~~***ves*** ](https://discord.com/channels/${guildId}/${ticketChannelId})    ＃ __ ${queueNum} __‬‬
~~                                                                                ~~
<:blue:1554781672992407552>    <@${buyerId}>
>   ${item}    <:hearty:1554781762813558804>    ${info}
>   ${payment}  <:hearty:1554781762813558804> ${price}
_ _
-# _ _        sea shore  ~~        ~~  <@${staffId}>
-# _ _        **   ${statusText}**  ${getGMT8Time()}
~~                                                                                ~~
_ _`;

    return new EmbedBuilder().setColor(PASTEL_BLUE).setDescription(description);
}

async function handleQueueCommand(interaction) {
    if (!isStaff(interaction.member)) {
        return interaction.reply({ content: 'You do not have permission to use this command.', flags: MessageFlags.Ephemeral });
    }

    const buyer = interaction.options.getUser('buyer');
    const item = interaction.options.getString('item');
    const info = interaction.options.getString('info');
    const payment = interaction.options.getString('payment');
    const price = interaction.options.getString('price');
    const ticketChannelId = interaction.channelId;
    const staffUser = interaction.user;
    const currentQueueNum = queueCounter++;

    queueStore.set(ticketChannelId, {
        queueNum: currentQueueNum,
        buyerId: buyer.id,
        item,
        info,
        payment,
        price,
        staffId: staffUser.id
    });

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const localEmbed = new EmbedBuilder()
        .setColor(PASTEL_BLUE)
        .setDescription(
`_ _
     \`    order  tracker  \`
~~                                                        ~~
> -# _ _ **nb & dekors**    \` \`    mto
> -# _ _  **game topups**  \` \`    mins-hrs
> -# _ _  **roblx bobaks**  \` \`    mins-days
~~                                                        ~~
> track your order [here](https://discord.com/channels/1507214174084927498/1539239066049060974) ! 𓆉
> no rushing! pls, be patient.
~~                                                        ~~
_ _`
        );

    await interaction.channel.send({ embeds: [localEmbed] });
    await interaction.editReply({ content: 'Queue logged successfully!' });

    const queueEmbed = buildQueueEmbed(
        interaction.guildId,
        ticketChannelId,
        currentQueueNum,
        buyer.id,
        item,
        info,
        payment,
        price,
        staffUser.id,
        '[ order status ]'
    );

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`queue_noted_${ticketChannelId}`).setEmoji('🐚').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`queue_proc_${ticketChannelId}`).setEmoji('🫧').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`queue_comp_${ticketChannelId}`).setEmoji('🐋').setStyle(ButtonStyle.Secondary)
    );

    const queueChannel = await client.channels.fetch(QUEUE_CHANNEL_ID).catch(() => null);
    if (queueChannel) {
        await queueChannel.send({ embeds: [queueEmbed], components: [row] });
    }
}

async function handleQueueButtons(interaction) {
    if (!isStaff(interaction.member)) {
        return interaction.reply({ content: 'Only staff can update queue status.', flags: MessageFlags.Ephemeral });
    }

    const [, action, ticketChannelId] = interaction.customId.split('_');
    let data = queueStore.get(ticketChannelId);

    if (!data) {
        const embed = interaction.message.embeds[0];
        if (!embed || !embed.description) return;

        const queueMatch = embed.description.match(/＃ __ (\d+) __/);
        const buyerMatch = embed.description.match(/<@(\d+)>/);
        const staffMatch = embed.description.match(/sea shore  ~~        ~~  <@(\d+)>/);

        data = {
            queueNum: queueMatch ? queueMatch[1] : '?',
            buyerId: buyerMatch ? buyerMatch[1] : interaction.user.id,
            item: 'Item',
            info: 'Info',
            payment: 'Payment',
            price: 'Price',
            staffId: staffMatch ? staffMatch[1] : interaction.user.id
        };
    }

    let statusLabel = action === 'noted' ? 'NOTED' : action === 'proc' ? 'PROCESSING' : 'COMPLETED';

    const updatedEmbed = buildQueueEmbed(
        interaction.guildId,
        ticketChannelId,
        data.queueNum,
        data.buyerId,
        data.item,
        data.info,
        data.payment,
        data.price,
        data.staffId,
        statusLabel
    );

    const updatedComponents = interaction.message.components.map(row => {
        const newRow = new ActionRowBuilder();
        row.components.forEach(btn => {
            const btnBuilder = ButtonBuilder.from(btn);
            if (btn.customId === interaction.customId) btnBuilder.setDisabled(true);
            newRow.addComponents(btnBuilder);
        });
        return newRow;
    });

    await interaction.update({ embeds: [updatedEmbed], components: updatedComponents });

    if (action === 'comp') {
        try {
            const ticketChannel = await client.channels.fetch(ticketChannelId).catch(() => null);
            if (ticketChannel) {
                const completionEmbed = new EmbedBuilder()
                    .setColor(PASTEL_BLUE)
                    .setDescription(
`_ _
                    **   hey there,  coral ! ** 
-#    your order has been completed. kindly vouch us 
-#    within 12 hours to activate your item's warranty !
_ _
> -# _ _        thank you for your trust & support !
\`              𓆝 𓆟 𓆞 𓆝 𓆟        \`
_ _`
                    );

                const vouchButtonRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setLabel('vouch here').setStyle(ButtonStyle.Link).setURL(VOUCH_URL)
                );

                await ticketChannel.send({
                    content: `<@${data.buyerId}>`,
                    embeds: [completionEmbed],
                    components: [vouchButtonRow]
                });
            }
        } catch (err) {
            console.error('Could not send completion message to ticket channel:', err.message || err);
        }
    }
}

// ==========================================
// MODULE 2: TICKET SYSTEM FUNCTIONS
// ==========================================
async function handleTicketSetupCommand(interaction) {
    const embed = new EmbedBuilder()
        .setColor(PASTEL_BLUE)
        .setDescription(
`_ _
# _ _     tick__kette__ b*oo*th <:butterfly:1554370425587245066>
_ _
    always  ask  in  <#1507214174084927501> 
    before ordering and opening a
    ticket! 
_ _
>  ꫂ❁  **tickette rules** :
> \` \`    payment first before process
> \` \`    do not open if you are unsure
> \` \`    no trolling.  ticket troll = ban !
> \` \`    reporting hrs: 1pm-10pm only
> \` \`    voided if  reported  outside  ^`
        )
        .setImage(BANNER_URL);

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('btn_order').setLabel('orders').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('btn_report').setLabel('reports').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('btn_others').setLabel('others').setStyle(ButtonStyle.Secondary)
    );

    await interaction.reply({ content: 'Ticket panel sent to channel!', flags: MessageFlags.Ephemeral });
    await interaction.channel.send({ embeds: [embed], components: [row] });
}

async function handleTicketButtons(interaction) {
    const customId = interaction.customId;

    if (['btn_order', 'btn_report', 'btn_others'].includes(customId)) {
        if (interaction.member && interaction.member.roles.cache.has(RESTRICTED_TICKET_ROLE_ID)) {
            return await interaction.reply({
                content: `You cannot open a ticket right now. You must vouch your previous item(s) in [vouch-items](${VOUCH_URL}) to regain access to create a ticket!`,
                flags: MessageFlags.Ephemeral
            });
        }
    }

    if (customId === 'btn_order') {
        const orderEmbed = new EmbedBuilder()
            .setColor(PASTEL_BLUE)
            .setDescription(
`_ _
             <a:spiral:1555857356082909315>  **order**  __αwαy__  ! 
> click  on  the button on the item 
> you wish to purchαse from here.
-# **note**: this is αn αuto buy system. once u
-# click the button, it will notify the stαffs!
_ _`
            )
            .setImage(BANNER_URL);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('btn_bobaks').setLabel('bobaks').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('btn_topups').setLabel('topups').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('btn_dc_items').setLabel('dc items').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('btn_premiums').setLabel('premiums').setStyle(ButtonStyle.Secondary)
        );

        return await interaction.reply({ embeds: [orderEmbed], components: [row], flags: MessageFlags.Ephemeral });
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
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('game_name').setLabel('gαme nαme:').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('private_server_link').setLabel('privαte server link:').setStyle(TextInputStyle.Short).setRequired(true)),
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

    if (customId !== 'modal_close_reason') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const usernameSanitized = interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '');
        let channelPrefix = 'order';
        let targetCategoryId = ORDER_CATEGORY_ID;
        let formFields = [];

        if (['modal_gamepass_ct', 'modal_viaplus_rush', 'modal_ingame_gifting', 'modal_viaplus_wtw', 'modal_group_payout'].includes(customId)) {
            channelPrefix = 'rbx';
            targetCategoryId = ORDER_CATEGORY_ID;
        } else if (customId === 'modal_topups') {
            channelPrefix = 'topup';
            targetCategoryId = ORDER_CATEGORY_ID;
        } else if (customId === 'modal_dc_items') {
            channelPrefix = 'dc';
            targetCategoryId = ORDER_CATEGORY_ID;
        } else if (customId === 'modal_premiums') {
            channelPrefix = 'prem';
            targetCategoryId = ORDER_CATEGORY_ID;
        } else if (customId === 'modal_report') {
            channelPrefix = 'report';
            targetCategoryId = REPORT_CATEGORY_ID;
        } else if (customId === 'modal_others') {
            channelPrefix = 'others';
            targetCategoryId = OTHERS_CATEGORY_ID;
        }

        try {
            if (customId === 'modal_gamepass_ct') {
                formFields = [
                    { name: 'Roblox Username', value: interaction.fields.getTextInputValue('roblox_username') },
                    { name: 'Gamepass Link', value: interaction.fields.getTextInputValue('gamepass_link') },
                    { name: 'Amount to Purchase', value: interaction.fields.getTextInputValue('amount') }
                ];
            } else if (customId === 'modal_viaplus_rush') {
                formFields = [
                    { name: 'Roblox Username', value: interaction.fields.getTextInputValue('roblox_username') },
                    { name: 'Display Name', value: interaction.fields.getTextInputValue('display_name') },
                    { name: 'Amount', value: interaction.fields.getTextInputValue('amount') },
                    { name: '2FA Enabled?', value: interaction.fields.getTextInputValue('two_fa') }
                ];
            } else if (customId === 'modal_ingame_gifting') {
                formFields = [
                    { name: 'Roblox Username', value: interaction.fields.getTextInputValue('roblox_username') },
                    { name: 'Display Name', value: interaction.fields.getTextInputValue('display_name') },
                    { name: 'Amount', value: interaction.fields.getTextInputValue('amount') },
                    { name: 'Game Name', value: interaction.fields.getTextInputValue('game_name') },
                    { name: 'Private Server Link', value: interaction.fields.getTextInputValue('private_server_link') },
                    { name: 'Lvl Requirements?', value: interaction.fields.getTextInputValue('lvl_req') }
                ];
            } else if (customId === 'modal_viaplus_wtw') {
                formFields = [
                    { name: 'Roblox Username', value: interaction.fields.getTextInputValue('roblox_username') },
                    { name: 'Display Name', value: interaction.fields.getTextInputValue('display_name') },
                    { name: 'Amount', value: interaction.fields.getTextInputValue('amount') },
                    { name: '2FA Enabled?', value: interaction.fields.getTextInputValue('two_fa') }
                ];
            } else if (customId === 'modal_group_payout') {
                formFields = [
                    { name: 'Roblox Username', value: interaction.fields.getTextInputValue('roblox_username') },
                    { name: 'Display Name', value: interaction.fields.getTextInputValue('display_name') },
                    { name: 'Amount', value: interaction.fields.getTextInputValue('amount') }
                ];
            } else if (customId === 'modal_topups') {
                formFields = [
                    { name: 'Game Name', value: interaction.fields.getTextInputValue('game_name') },
                    { name: 'Order Name', value: interaction.fields.getTextInputValue('order_name') },
                    { name: 'In-Game Details', value: interaction.fields.getTextInputValue('ingame_details') },
                    { name: 'Quantity', value: interaction.fields.getTextInputValue('quantity') }
                ];
            } else if (customId === 'modal_dc_items') {
                formFields = [
                    { name: 'Item Name', value: interaction.fields.getTextInputValue('item_name') },
                    { name: 'Gift Link / Login', value: interaction.fields.getTextInputValue('gift_link') },
                    { name: 'Quantity', value: interaction.fields.getTextInputValue('quantity') }
                ];
            } else if (customId === 'modal_premiums') {
                formFields = [
                    { name: 'Item Name', value: interaction.fields.getTextInputValue('item_name') },
                    { name: 'Subscription', value: interaction.fields.getTextInputValue('subscription') },
                    { name: 'Quantity', value: interaction.fields.getTextInputValue('quantity') }
                ];
            } else if (customId === 'modal_report') {
                formFields = [
                    { name: 'Discord Username', value: interaction.fields.getTextInputValue('dc_username') },
                    { name: 'Report Reason', value: interaction.fields.getTextInputValue('report_reason') },
                    { name: 'Vouch Link', value: interaction.fields.getTextInputValue('vouch_link') }
                ];
            } else if (customId === 'modal_others') {
                formFields = [
                    { name: 'Reason for opening a ticket', value: interaction.fields.getTextInputValue('reason') }
                ];
            }
        } catch (fieldErr) {
            console.error('Error fetching modal text input value:', fieldErr.message);
        }

        const channelName = `${channelPrefix}-${usernameSanitized}`;

        try {
            const permissionOverwrites = [
                { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
                { id: interaction.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] }
            ];

            STAFF_ROLE_IDS.forEach(roleId => {
                permissionOverwrites.push({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
            });

            const ticketChannel = await interaction.guild.channels.create({
                name: channelName,
                type: ChannelType.GuildText,
                parent: targetCategoryId,
                permissionOverwrites: permissionOverwrites
            });

            ticketStore.set(ticketChannel.id, { buyerId: interaction.user.id, claimedByStaffId: null });

            await interaction.editReply({ content: `✅ Your ticket has been created! Click here to go to your channel: <#${ticketChannel.id}>` });

            const formattedFields = formFields.map(field => ({
                name: field.name,
                value: field.value || 'N/A',
                inline: false
            }));

            const ticketEmbed = new EmbedBuilder()
                .setColor(PASTEL_BLUE)
                .setTitle(`Ticket Opened by ${interaction.user.username}`)
                .addFields(formattedFields)
                .setImage(BANNER_URL);

            const ticketButtons = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('claim_ticket').setLabel('claim').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('close_ticket').setLabel('close').setStyle(ButtonStyle.Secondary)
            );

            const staffPings = STAFF_ROLE_IDS.map(id => `<@&${id}>`).join(' ');

            await ticketChannel.send({
                content: `${staffPings} ${interaction.user}`,
                embeds: [ticketEmbed],
                components: [ticketButtons]
            });
        } catch (err) {
            console.error('Failed to create ticket channel or send message:', err.message || err);
            await interaction.editReply({ content: 'Failed to create ticket channel. Please check bot permissions or Category ID configuration.' });
        }
        return;
    }

    if (customId === 'modal_close_reason') {
        const closeReason = interaction.fields.getTextInputValue('close_reason');
        const channel = interaction.channel;
        const closedByStaffId = interaction.user.id;

        const ticketData = ticketStore.get(channel.id) || {};
        const buyerId = ticketData.buyerId || 'Unknown Buyer';
        const claimedByStaffId = ticketData.claimedByStaffId ? `<@${ticketData.claimedByStaffId}>` : 'None';

        await interaction.reply('Ticket will be closed in 10 seconds, generating transcript!');

        setTimeout(async () => {
            try {
                const transcriptFile = await discordTranscripts.createTranscript(channel, {
                    limit: -1,
                    fileName: `transcript-${channel.name}.html`,
                    poweredBy: false
                });

                const transcriptEmbed = new EmbedBuilder()
                    .setColor(PASTEL_BLUE)
                    .setDescription(
`_ _
               ❦     **𝓣ickette __𝓒losed__**
> **opened by** : <@${buyerId}>
> **catered by** : ${claimedByStaffId}
> **closed by** : <@${closedByStaffId}>

> **REASON** : ${closeReason}
_ _`
                    )
                    .setImage(BANNER_URL);

                const transcriptChannel = interaction.guild.channels.cache.get(TRANSCRIPT_CHANNEL_ID);
                let transcriptMsg = null;
                if (transcriptChannel) {
                    transcriptMsg = await transcriptChannel.send({ embeds: [transcriptEmbed], files: [transcriptFile] });
                }

                const dmEmbed = new EmbedBuilder()
                    .setColor(PASTEL_BLUE)
                    .setDescription(
`_ _
               ❦     **𝓣ickette __𝓒losed__**
-# _ _         thαnk you for trusting coαstαl cαrt !
> -# _ _     your tickette wαs __cαtered__ by : ${claimedByStaffId}
_ _`
                    )
                    .setImage(BANNER_URL);

                let transcriptComponents = [];
                if (transcriptMsg) {
                    const transcriptLinkButton = new ButtonBuilder()
                        .setLabel('view transcript')
                        .setStyle(ButtonStyle.Link)
                        .setURL(transcriptMsg.url);
                    transcriptComponents.push(new ActionRowBuilder().addComponents(transcriptLinkButton));
                }

                try {
                    const buyerUser = await client.users.fetch(buyerId).catch(() => null);
                    if (buyerUser) {
                        await buyerUser.send({ embeds: [dmEmbed], components: transcriptComponents });
                    }
                } catch (dmErr) {
                    console.error('Could not send DM to buyer:', dmErr.message || dmErr);
                }

                ticketStore.delete(channel.id);
                await channel.delete();

            } catch (err) {
                console.error('Error during ticket closure and transcript generation:', err.message || err);
            }
        }, 10000);
    }
}

// ==========================================
// MODULE 3: MODE OF PAYMENT (MOP) FUNCTIONS
// ==========================================
const GCASH_QR_URL = 'https://cdn.discordapp.com/attachments/1553697060056866906/1555828587649568838/Screenshot_2026-10-03_at_2.27.13_PM.png?backend=b2&ex=6ac1f1c9&is=6ac0a049&hm=2e41195db20ad2cd8d5649692ff1365f5b54e0ea6eb26e5f03d35dc4ba88aa6d';

async function handleMopCommand(interaction) {
    if (!isStaff(interaction.member)) {
        return interaction.reply({ content: 'Only staff can use this command.', flags: MessageFlags.Ephemeral });
    }

    const amount = interaction.options.getNumber('amount');

    const mainEmbed = new EmbedBuilder()
        .setColor(PASTEL_BLUE)
        .setDescription(
`_ _
         ** [꒰ mode of payments accepted ꒱](https://coastal-cart.gg)**
~~                                                                                ~~
-# _ _      gcash  ( no fee )      Ი𐑼      go-tyme ( + 10 )     
-# _ _      maya  ( + 10 )        Ი𐑼        paypal ( fnf )
~~                                                                                ~~ 
> -# _ _  send a clear screenshot  of  the  receipt. 
> -# _ _  saved receipts will not be credited,  and 
> -# _ _  a transaction history is required.
~~                                                                                ~~
-# _ _  proceed with payment? click the button below!
_ _`
        );

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`proceed_payment_${amount}`)
            .setLabel('proceed to payment')
            .setStyle(ButtonStyle.Secondary)
    );

    await interaction.reply({ embeds: [mainEmbed], components: [row] });
}

async function handleMopButtons(interaction) {
    const customId = interaction.customId;

    if (customId.startsWith('proceed_payment_')) {
        const amount = parseFloat(customId.replace('proceed_payment_', ''));

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`mop_select_gcash_${amount}`).setLabel('gcash').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`mop_select_maya_${amount}`).setLabel('maya').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`mop_select_gotyme_${amount}`).setLabel('gotyme').setStyle(ButtonStyle.Secondary)
        );

        await interaction.reply({
            content: `Select your preferred payment method (Amount: ₱${amount}):`,
            components: [row],
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    if (customId.startsWith('mop_select_')) {
        const [, , type, amountStr] = customId.split('_');
        const amount = parseFloat(amountStr);

        if (type === 'gcash') {
            const modal = new ModalBuilder().setCustomId(`tip_modal_${amount}`).setTitle('Add a Tip?');
            const tipInput = new TextInputBuilder().setCustomId('tip_amount').setLabel('Tip Amount in PHP (Enter 0 for no tip)').setStyle(TextInputStyle.Short).setValue('0').setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(tipInput));
            await interaction.showModal(modal);
        } else if (type === 'maya') {
            await renderMopEmbed(interaction, 'maya', amount, 10);
        } else if (type === 'gotyme') {
            await renderMopEmbed(interaction, 'gotyme', amount, 10);
        }
        return;
    }

    if (customId === 'copy_maya_num') {
        return await interaction.reply({ content: '`09184552148`', flags: MessageFlags.Ephemeral });
    }
    if (customId === 'copy_gotyme_num') {
        return await interaction.reply({ content: '`016381151370`', flags: MessageFlags.Ephemeral });
    }
}

async function handleMopModals(interaction) {
    if (interaction.customId.startsWith('tip_modal_')) {
        const amount = parseFloat(interaction.customId.replace('tip_modal_', ''));
        const tipVal = parseFloat(interaction.fields.getTextInputValue('tip_amount')) || 0;
        await renderMopEmbed(interaction, 'gcash', amount, tipVal);
    }
}

async function renderMopEmbed(interaction, mopType, amount, feeOrTip = 0) {
    let descriptionText = '';
    let componentsRow = null;
    let imageUrl = null;

    if (mopType === 'gcash') {
        descriptionText = 
`_ _
# _ _     𝓖ca**s**h   (  001  )    
~~                                                                        ~~
          \`    0918  455  2148   \`
~~                                                                        ~~
-# _ _                **Tag bubbles when sending receipts!**`;
        imageUrl = GCASH_QR_URL;
    } else if (mopType === 'maya') {
        descriptionText = 
`_ _
# _ _     𝓜a**y**a   (  002  )    
~~                                                                        ~~
          \`    0918  455  2148   \`
~~                                                                        ~~
-# _ _                **𝓒opy the number below!**`;

        componentsRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('copy_maya_num').setLabel('copy maya account number').setStyle(ButtonStyle.Secondary)
        );
    } else if (mopType === 'gotyme') {
        descriptionText = 
`_ _
# _ _     𝓖oty**m**e   (  003  )    
~~                                                                        ~~
          \`    0163 8115 1370   \`
~~                                                                        ~~
-# _ _                **𝓒opy the number below!**`;

        componentsRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('copy_gotyme_num').setLabel('copy gotyme account number').setStyle(ButtonStyle.Secondary)
        );
    }

    const embed = new EmbedBuilder()
        .setColor(PASTEL_BLUE)
        .setDescription(descriptionText);

    if (imageUrl) embed.setImage(imageUrl);

    const messageData = { embeds: [embed], components: componentsRow ? [componentsRow] : [] };

    if (interaction.isModalSubmit()) {
        await interaction.reply(messageData);
    } else if (interaction.isButton()) {
        await interaction.reply(messageData);
    }
}

client.login(process.env.DISCORD_TOKEN);
