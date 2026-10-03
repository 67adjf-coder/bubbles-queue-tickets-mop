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
    AttachmentBuilder,
    PermissionFlagsBits,
    ChannelType
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

const STAFF_ROLE_ID = '1533372358755221566';
const QUEUE_CHANNEL_ID = '1539239066049060974';
const TRANSCRIPT_CHANNEL_ID = '1507278726998524046';
const VOUCH_URL = 'https://discord.com/channels/1507214174084927498/1507271897962778706';
const BANNER_URL = 'https://cdn.discordapp.com/attachments/1553697060056866906/1554405328462938162/Coral_Reef_Sea_GIF_-_Coral_Reef_Sea_Ocean_-_Discover__Share_GIFs.gif?ex=6abf6745&is=6abe15c5&hm=7248fb3fe9a07a4857b393db5d6a767808fb7d12d910cd4e1bcd95281abb5a18';
const PASTEL_BLUE = 0xAEC6CF;

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

async function generateQRBuffer(text) {
    return await QRCode.toBuffer(text, { margin: 1, width: 300 });
}

function isStaff(member, user) {
    if (user && user.id === STAFF_ROLE_ID) return true;
    return member && member.roles && member.roles.cache.has(STAFF_ROLE_ID);
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
    if (interaction.isModalSubmit() && ['modal_order', 'modal_report', 'modal_others', 'modal_close_reason'].includes(interaction.customId)) {
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
            // 1. Download image buffer via Axios
            const response = await axios.get(attachment.url, { responseType: 'arraybuffer' });
            const inputBuffer = Buffer.from(response.data);

            // 2. Pre-process image with Jimp (Grayscale + Contrast + Resize) for optimal OCR reading
            const image = await Jimp.read(inputBuffer);
            image.greyscale().contrast(0.2).resize(1000, Jimp.AUTO);
            const processedBuffer = await image.getBufferAsync(Jimp.MIME_PNG);

            // 3. Run Tesseract OCR
            const { data: { text } } = await Tesseract.recognize(processedBuffer, 'eng');
            console.log('--- OCR RAW TEXT ---');
            console.log(text);
            console.log('--------------------');

            // 4. Regex Patterns for GCash, Maya, GoTyme
            const refPatterns = [
                /(?:Ref\s*No\.|Reference\s*No\.|Ref\.|Transaction\s*No\.|Txn\s*ID|Control\s*No\.)\s*[:#-]?\s*([0-9\s]{9,20})/i,
                /\b00\d{10,12}\b/,                           // GCash standard ref starting with 00
                /\b\d{13}\b/,                                 // Standard 13-digit GCash Ref
                /\b\d{4}\s?\d{3}\s?\d{6}\b/,                 // Spaced GCash Ref
                /\b\d{4}\s?\d{4}\s?\d{4}\b/                  // Maya/GoTyme 12-digit Ref
            ];

            const amountPatterns = [
                /(?:Total\s*Amount\s*Sent|Amount|Total|Paid)\s*[:#-]?\s*(?:PHP|P|₱)?\s*([\d,]+\.\d{2})/i,
                /(?:PHP|P|₱)\s*([\d,]+\.\d{2})/i,
                /\b([\d,]+\.\d{2})\b/                        // Standalone amount like 224.00
            ];

            // Extract Reference Number
            let extractedRef = null;
            for (const pattern of refPatterns) {
                const match = text.match(pattern);
                if (match) {
                    extractedRef = (match[1] || match[0]).replace(/\s+/g, '').trim();
                    break;
                }
            }

            // Extract Amount
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
            console.error('OCR Processing Error details:', error);
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
     𓂃 𓈒𓏸‪‪ 𓇼    [ **tid**__a__**l** **w**~~a~~***ves*** ](https://discord.com/channels/\({guildId}/\){ticketChannelId})   ＃ __ ${queueNum} __
~~                                                                                ~~
<:blue:1554781672992407552>    <@${buyerId}>
>   ${item}   <:hearty:1554781762813558804>   ${info}
>   ${payment}  <:hearty:1554781762813558804> ${price}
_ _
-# _ _        sea shore  ~~        ~~  <@${staffId}>
-# _ _        **  ${statusText}**  ${getGMT8Time()}
~~                                                                                ~~
_ _`;

    return new EmbedBuilder().setColor(PASTEL_BLUE).setDescription(description);
}

async function handleQueueCommand(interaction) {
    if (!isStaff(interaction.member, interaction.user)) {
        return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
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

    await interaction.deferReply({ ephemeral: true });

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
    if (!isStaff(interaction.member, interaction.user)) {
        return interaction.reply({ content: 'Only staff can update queue status.', ephemeral: true });
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
                    **  hey there,  coral ! ** 
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
            console.error('Could not send completion message to ticket channel:', err);
        }
    }
}


// ==========================================
// CONFIGURATION (Category IDs)
// ==========================================
const ORDER_CATEGORY_ID = '1537390467921215498';
const REPORT_CATEGORY_ID = '1537434112951062598';
const OTHERS_CATEGORY_ID = '1555853722788302848';

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
        new ButtonBuilder().setCustomId('btn_order').setLabel('order').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('btn_report').setLabel('report').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('btn_others').setLabel('others').setStyle(ButtonStyle.Secondary)
    );

    await interaction.reply({ content: 'Ticket panel sent to channel!', ephemeral: true });
    await interaction.channel.send({ embeds: [embed], components: [row] });
}

async function handleTicketButtons(interaction) {
    const customId = interaction.customId;

    if (customId === 'btn_order') {
        const modal = new ModalBuilder().setCustomId('modal_order').setTitle('Order Ticket Form');
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('product_name').setLabel('product name:').setPlaceholder('the product you wish to purchase').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('quantity').setLabel('quantity:').setPlaceholder('how many pcs will you buy').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('details').setLabel('details:').setPlaceholder('uid, id, and username ( put N/A if not applicable )').setStyle(TextInputStyle.Paragraph).setRequired(true))
        );
        return await interaction.showModal(modal);
    }

    if (customId === 'btn_report') {
        const modal = new ModalBuilder().setCustomId('modal_report').setTitle('Report Ticket Form');
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('product_name').setLabel('product name:').setPlaceholder('the product you wish to report').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('months_purchased').setLabel('months purchased:').setPlaceholder('how many months is the product item').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('item_issue').setLabel('item issue:').setPlaceholder('explain the issue of the product').setStyle(TextInputStyle.Paragraph).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('vouch_link').setLabel('vouch link :').setPlaceholder('paste the link of your vouch').setStyle(TextInputStyle.Short).setRequired(true))
        );
        return await interaction.showModal(modal);
    }

    if (customId === 'btn_others') {
        const modal = new ModalBuilder().setCustomId('modal_others').setTitle('Others Ticket Form');
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('reason for opening a ticket:').setPlaceholder('application, partnership, etc.').setStyle(TextInputStyle.Paragraph).setRequired(true))
        );
        return await interaction.showModal(modal);
    }

    if (customId === 'claim_ticket') {
        if (!isStaff(interaction.member, interaction.user)) {
            return interaction.reply({ content: 'Only staff can claim tickets.', ephemeral: true });
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
        await interaction.channel.send(`ticket claimed by : ${interaction.user}`);
        return;
    }

    if (customId === 'close_ticket') {
        if (!isStaff(interaction.member, interaction.user)) {
            return interaction.reply({ content: 'Only staff can close tickets.', ephemeral: true });
        }

        const modal = new ModalBuilder().setCustomId('modal_close_reason').setTitle('Close Ticket');
        const reasonInput = new TextInputBuilder()
            .setCustomId('close_reason')
            .setLabel('Reason for closing ticket:')
            .setPlaceholder('Enter the reason for closing this ticket...')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
        return await interaction.showModal(modal);
    }
}

async function handleTicketModals(interaction) {
    if (['modal_order', 'modal_report', 'modal_others'].includes(interaction.customId)) {
        await interaction.deferReply({ ephemeral: true });

        const usernameSanitized = interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '');
        let channelPrefix = '';
        let targetCategoryId = '';
        let formFields = [];

        if (interaction.customId === 'modal_order') {
            channelPrefix = 'order';
            targetCategoryId = ORDER_CATEGORY_ID;
            formFields = [
                { name: 'Product Name', value: interaction.fields.getTextInputValue('product_name') },
                { name: 'Quantity', value: interaction.fields.getTextInputValue('quantity') },
                { name: 'Details', value: interaction.fields.getTextInputValue('details') }
            ];
        } else if (interaction.customId === 'modal_report') {
            channelPrefix = 'report';
            targetCategoryId = REPORT_CATEGORY_ID;
            formFields = [
                { name: 'Product Name', value: interaction.fields.getTextInputValue('product_name') },
                { name: 'Months Purchased', value: interaction.fields.getTextInputValue('months_purchased') },
                { name: 'Item Issue', value: interaction.fields.getTextInputValue('item_issue') },
                { name: 'Vouch Link', value: interaction.fields.getTextInputValue('vouch_link') }
            ];
        } else if (interaction.customId === 'modal_others') {
            channelPrefix = 'others';
            targetCategoryId = OTHERS_CATEGORY_ID;
            formFields = [
                { name: 'Reason for opening a ticket', value: interaction.fields.getTextInputValue('reason') }
            ];
        }

        const channelName = `\ ${channelPrefix}-${usernameSanitized}`;

        try {
            const ticketChannel = await interaction.guild.channels.create({
                name: channelName,
                type: ChannelType.GuildText,
                parent: targetCategoryId,
                permissionOverwrites: [
                    { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                    { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
                    { id: STAFF_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
                ]
            });

            ticketStore.set(ticketChannel.id, { buyerId: interaction.user.id, claimedByStaffId: null });

            await interaction.editReply({ content: `Your ticket has been created: <#${ticketChannel.id}>` });

            const ticketEmbed = new EmbedBuilder()
                .setColor(PASTEL_BLUE)
                .setTitle(`Ticket Opened by ${interaction.user.tag}`)
                .addFields(formFields)
                .setImage(BANNER_URL);

            const ticketButtons = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('claim_ticket').setLabel('claim').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('close_ticket').setLabel('close').setStyle(ButtonStyle.Secondary)
            );

            await ticketChannel.send({
                content: `<@&${STAFF_ROLE_ID}> ${interaction.user}`,
                embeds: [ticketEmbed],
                components: [ticketButtons]
            });
        } catch (err) {
            console.error('Failed to create ticket channel:', err);
            await interaction.editReply({ content: 'Failed to create ticket channel. Please check bot permissions or Category ID configuration.' });
        }
        return;
    }

    if (interaction.customId === 'modal_close_reason') {
        const closeReason = interaction.fields.getTextInputValue('close_reason');
        const channel = interaction.channel;
        const closedByStaffId = interaction.user.id;

        const ticketData = ticketStore.get(channel.id) || {};
        const buyerId = ticketData.buyerId || 'Unknown Buyer';
        const claimedByStaffId = ticketData.claimedByStaffId ? `<@${ticketData.claimedByStaffId}>` : 'None';

        await interaction.reply('Ticket will be closed in 10 seconds, generating transcript!');

        // 10000ms = 10 seconds
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
> catered by : ${claimedByStaffId}
> closed by : <@${closedByStaffId}>
_ _
> buyer : <@${buyerId}>
> reason: ${closeReason}
_ _`
                    )
                    .setImage(BANNER_URL);

                const transcriptChannel = interaction.guild.channels.cache.get(TRANSCRIPT_CHANNEL_ID);
                if (transcriptChannel) {
                    await transcriptChannel.send({ embeds: [transcriptEmbed], files: [transcriptFile] });
                }

                try {
                    const buyerUser = await client.users.fetch(buyerId).catch(() => null);
                    if (buyerUser) {
                        await buyerUser.send({ embeds: [transcriptEmbed], files: [transcriptFile] });
                    }
                } catch (dmErr) {
                    console.error('Could not send DM to buyer:', dmErr);
                }

                ticketStore.delete(channel.id);
                await channel.delete();

            } catch (err) {
                console.error('Error during ticket closure and transcript generation:', err);
            }
        }, 10000); 
    }
}

// ==========================================
// MODULE 3: MODE OF PAYMENT (MOP) FUNCTIONS
// ==========================================

const GCASH_QR_URL = 'https://cdn.discordapp.com/attachments/1553697060056866906/1555828587649568838/Screenshot_2026-10-03_at_2.27.13_PM.png?backend=b2&ex=6ac1f1c9&is=6ac0a049&hm=2e41195db20ad2cd8d5649692ff1365f5b54e0ea6eb26e5f03d35dc4ba88aa6d';

async function handleMopCommand(interaction) {
    if (!isStaff(interaction.member, interaction.user)) {
        return interaction.reply({ content: 'Only staff can use this command.', ephemeral: true });
    }

    const amount = interaction.options.getNumber('amount');

    const mainEmbed = new EmbedBuilder()
        .setColor(PASTEL_BLUE)
        .setDescription(
`_ _
         ** [꒰ mode of payments accepted ꒱](https://coastal-cart.gg)**
~~                                                                        ~~
-# _ _      gcash  ( no fee )      Ი𐑼      go-tyme ( + 10 )     
-# _ _      maya  ( + 10 )        Ი𐑼        paypal ( fnf )
~~                                                                        ~~ 
> -# _ _  send a clear screenshot  of  the  receipt. 
> -# _ _  saved receipts will not be credited,  and 
> -# _ _  a transaction history is required.
~~                                                                        ~~
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
            ephemeral: true
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
        return await interaction.reply({ content: '`09184552148`', ephemeral: true });
    }
    if (customId === 'copy_gotyme_num') {
        return await interaction.reply({ content: '`016381151370`', ephemeral: true });
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
-# _ _                **𝓢can the qr code below!**
-# _ _                **𝓣ag bubbles when sending receipts!**`;
        imageUrl = GCASH_QR_URL;
    } else if (mopType === 'maya') {
        descriptionText = 
`_ _
# _ _     𝓜a**y**a   (  002  )     
~~                                                                        ~~
          \`   0918  455  2148   \`
~~                                                                        ~~
-# _ _                **𝓒opy the number below!**
-# _ _                **𝓣ag bubbles when sending receipts!**`;

        componentsRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('copy_maya_num').setLabel('copy maya account number').setStyle(ButtonStyle.Secondary)
        );
    } else if (mopType === 'gotyme') {
        descriptionText = 
`_ _
# _ _     𝓖oty**m**e   (  003  )     
~~                                                                        ~~
          \`   0163 8115 1370   \`
~~                                                                        ~~
-# _ _                **𝓒opy the number below!**
-# _ _                **𝓣ag bubbles when sending receipts!**`;

        componentsRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('copy_gotyme_num').setLabel('copy gotyme account number').setStyle(ButtonStyle.Secondary)
        );
    }

    const embed = new EmbedBuilder()
        .setColor(PASTEL_BLUE)
        .setDescription(descriptionText);

    if (imageUrl) {
        embed.setImage(imageUrl);
    }

    const replyOptions = { embeds: [embed] };

    if (componentsRow) {
        replyOptions.components = [componentsRow];
    }

    if (interaction.replied || interaction.deferred) {
        await interaction.followUp(replyOptions);
    } else {
        await interaction.reply(replyOptions);
    }
}

// ==========================================
// BOT LOGIN
// ==========================================
client.login(process.env.DISCORD_TOKEN);
