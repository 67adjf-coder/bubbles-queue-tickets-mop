const { 
    Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, 
    ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, 
    ModalBuilder, TextInputBuilder, TextInputStyle, AttachmentBuilder, 
    PermissionFlagsBits, ChannelType, StringSelectMenuBuilder, 
    StringSelectMenuOptionBuilder, MessageFlags, ActivityType 
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

const STAFF_ROLE_ID = '1533372358755221566';
const RESTRICTED_TICKET_ROLE_ID = '1557329338943283240'; // No-Vouch Role ID
const TARGET_QUEUE_CHANNEL_ID = '1539239066049060974';
const TRANSCRIPT_CHANNEL_ID = '1507278726998524046';
const VOUCH_URL = 'https://discord.com/channels/1507214174084927498/1507271897962778706';
const BANNER_URL = 'https://cdn.discordapp.com/attachments/1553697060056866906/1554405328462938162/Coral_Reef_Sea_GIF_-_Coral_Reef_Sea_Ocean_-_Discover__Share_GIFs.gif?ex=6abf6745&is=6abe15c5&hm=7248fb3fe9a07a4857b393db5d6a767808fb7d12d910cd4e1bcd95281abb5a18';
const PASTEL_BLUE = 0xAEC6CF;

// Category IDs for Tickets
const ORDER_CATEGORY_ID = '1537390467921215498';
const REPORT_CATEGORY_ID = '1537434112951062598';
const OTHERS_CATEGORY_ID = '1555853722788302848';

// --- In-Memory Stores & Helpers ---
const ticketStore = new Map();

function isStaff(member) {
    if (!member || !member.roles) return false;
    return member.roles.cache.has(STAFF_ROLE_ID);
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
        .setDescription('Create a new queue order tracker')
        .addUserOption(opt => opt.setName('buyer').setDescription('Buyer').setRequired(true))
        .addStringOption(opt => opt.setName('qty').setDescription('Quantity').setRequired(true))
        .addStringOption(opt => opt.setName('item_name').setDescription('Item name').setRequired(true))
        .addStringOption(opt => opt.setName('item_info').setDescription('Item info').setRequired(true))
        .addStringOption(opt => opt.setName('amnt').setDescription('Amount').setRequired(true))
        .addStringOption(opt => opt.setName('mop').setDescription('Mode of payment').setRequired(true)),

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
        if (interaction.isStringSelectMenu() && interaction.customId === 'queue_status_menu') {
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
        if (interaction.isStringSelectMenu() && interaction.customId === 'mop_select_menu') {
            return handleMopSelectMenu(interaction);
        }
        if (interaction.isButton() && ['mop_copy_num', 'mop_send_receipt'].includes(interaction.customId)) {
            return handleMopButtons(interaction);
        }
        if (interaction.isModalSubmit() && (interaction.customId.startsWith('mop_tip_modal_') || interaction.customId === 'mop_receipt_modal')) {
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

            const nowUTC = new Date().toUTCString();

            const receiptEmbed = new EmbedBuilder()
                .setColor(PASTEL_BLUE)
                .setTitle('🧾 Receipt Details Detected')
                .addFields(
                    { name: 'Reference Number', value: extractedRef ? `\`${extractedRef}\`` : '⚠️ *Not detected clearly*', inline: true },
                    { name: 'Amount Paid', value: extractedAmount ? `₱${extractedAmount}` : '⚠️ *Not detected clearly*', inline: true },
                    { name: 'Time Sent', value: nowUTC, inline: true },
                    { name: 'Payer', value: `${message.author}`, inline: false }
                )
                .setImage(attachment.url)
                .setFooter({ text: 'Notifying staff...' })
                .setTimestamp();

            await loadingMsg.edit({ 
                content: `✅ Receipt processed successfully! Notifying staff <@&${STAFF_ROLE_ID}>`, 
                embeds: [receiptEmbed] 
            });

        } catch (error) {
            console.error('OCR Processing Error:', error);
            await loadingMsg.edit('❌ Failed to read the receipt image automatically. Please wait for staff verification.');
        }
    }
});


// ==========================================
// SECTION 1: QUEUE SYSTEM MODULE (/queue-list)
// ==========================================
function getQueueDescription(buyerTag, qty, itemName, itemInfo, amnt, mop, staffUser, statusBlockquote) {
    return `_ _
         <:009:1568197445698064395> <:010:1568197472487088169>    ** by  the  ꗏeαshore **    *!*
-# _ _                    hιgh tιdes of grαtιtude
~~                                                                              ~~
-# _ _               <:002:1568197332883742810> : ${buyerTag}

-# _ _    <:glow_dots:1560696020852019310> # **${qty}**     oƒ     **${itemName}**
-# _ _    <:glow_dots:1560696020852019310> vιa : **${itemInfo}**
-# _ _    <:glow_dots:1560696020852019310> ꝓ \` ${amnt} \`   sᧉnt vιa **${mop}**
-# _ _         ιtem cαtered by : <@${staffUser.id}>
~~                                                                              ~~
${statusBlockquote}`;
}

function buildQueueComponents(isDisabled = false) {
    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('queue_status_menu')
        .setPlaceholder('select queue status...')
        .setDisabled(isDisabled)
        .addOptions(
            new StringSelectMenuOptionBuilder().setValue('noted').setLabel('noted'),
            new StringSelectMenuOptionBuilder().setValue('processing').setLabel('processing'),
            new StringSelectMenuOptionBuilder().setValue('completed').setLabel('completed')
        );

    return [new ActionRowBuilder().addComponents(selectMenu)];
}

async function handleQueueCommand(interaction) {
    if (!isStaff(interaction.member)) {
        return interaction.reply({ content: 'You do not have permission to use this command.', flags: MessageFlags.Ephemeral });
    }

    const buyer = interaction.options.getUser('buyer');
    const qty = interaction.options.getString('qty');
    const itemName = interaction.options.getString('item_name');
    const itemInfo = interaction.options.getString('item_info');
    const amnt = interaction.options.getString('amnt');
    const mop = interaction.options.getString('mop');

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const queueChannel = await client.channels.fetch(TARGET_QUEUE_CHANNEL_ID).catch(() => null);
    if (!queueChannel) {
        return interaction.editReply({ content: 'Error: Target queue channel could not be found.' });
    }

    const initialStatus = '> -# _ _     **ιtem sent to lιneup**';
    const description = getQueueDescription(buyer.toString(), qty, itemName, itemInfo, amnt, mop, interaction.user, initialStatus);
    
    const embed = new EmbedBuilder().setColor(PASTEL_BLUE).setDescription(description);
    const components = buildQueueComponents(false);

    await queueChannel.send({ embeds: [embed], components: components });
    await interaction.editReply({ content: `Queue successfully created in <#${TARGET_QUEUE_CHANNEL_ID}>!` });
}

async function handleQueueMenu(interaction) {
    if (!isStaff(interaction.member)) {
        return interaction.reply({ content: 'Only staff can update queue status.', flags: MessageFlags.Ephemeral });
    }

    const selectedValue = interaction.values[0];
    const embed = interaction.message.embeds[0];
    if (!embed || !embed.description) return;

    let newStatusBlock = '';
    let isCompleted = false;

    if (selectedValue === 'noted') {
        newStatusBlock = '> -# _ _     **your order ιs noted by ownιe**';
    } else if (selectedValue === 'processing') {
        newStatusBlock = '> -# _ _     **your order ιs beιng processed**  <:001_dns:1567870463366004756>';
    } else if (selectedValue === 'completed') {
        newStatusBlock = '> -# _ _     **your order ιs now delιvered**';
        isCompleted = true;
    }

    const updatedDesc = embed.description.replace(/>\s*-\#\s*_ _[\s\S]*$/, newStatusBlock);
    const updatedEmbed = EmbedBuilder.from(embed).setDescription(updatedDesc);
    const newComponents = buildQueueComponents(isCompleted);

    await interaction.update({ embeds: [updatedEmbed], components: newComponents });
}


// ==========================================
// SECTION 2: TICKET SYSTEM MODULE (/ticket-setup)
// ==========================================
async function handleTicketSetupCommand(interaction) {
    if (!isStaff(interaction.member)) {
        return interaction.reply({ content: 'You do not have permission to use this command.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const plainTextContent = `
_ _
         𓈒   ୭ৎ         tιckᧉttᧉ     :    boothᧉ     ⛲ᨯ    
-# _ _                    **reɑd notes before creɑting ɑ tix**

-# _ _          pɑyment first is required to purchɑse 
-# _ _          **do not** creɑte  ɑ  ticket just to ɑsk us!
-# _ _          iɑ tickette for 4 hours = closed + wɑrn
-# _ _          **do not** troll just to try d buttons = ban
-# _ _          use buttons ɑccordingly ɑnd correctly
    `;

    const gifEmbed = new EmbedBuilder()
        .setColor(PASTEL_BLUE)
        .setImage(BANNER_URL);

    await interaction.channel.send({ content: plainTextContent });

    const buttonRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('btn_order').setLabel('orders').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('btn_report').setLabel('reports').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('btn_others').setLabel('others').setStyle(ButtonStyle.Secondary)
    );

    await interaction.channel.send({ components: [buttonRow] });
    await interaction.channel.send({ embeds: [gifEmbed] });
    await interaction.editReply({ content: 'Ticket setup panel sent successfully!' });
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
             <a:spiral:1555857356082909315>  **order**  **αwαy**  ! 
click  on  the button on the item  
que wish to purchαse from here. 
-# **note** : this is αn αuto buy system. once u 
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
          <a:butterflynablue:1555246416115535903>    **report**    **αwαy**    !
click on the button below to report αnswer αll truthfully & completely ! 
-#  **note** : this is αn αutomαted system. do 
-#  wait for stαffs to αssist you in this mαtter. 
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
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('reason for opening a ticket:').setStyle(TextInputStyle.Paragraph).setRequired(true))
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
        const ticketData = ticketStore.get(channel.id) || {};

        try {
            const transcript = await discordTranscripts.createTranscript(channel, {
                limit: -1,
                returnType: 'attachment',
                filename: `transcript-${channel.name}.html`,
                saveImages: true,
                poweredBy: false
            });

            const openerId = ticketData.ownerId;
            const claimedStaffId = ticketData.claimedByStaffId;
            const openerUser = openerId ? await client.users.fetch(openerId).catch(() => null) : null;
            const claimedStaffText = claimedStaffId ? `<@${claimedStaffId}>` : '⚠️ *Unclaimed*';

            const transcriptChannel = await client.channels.fetch(TRANSCRIPT_CHANNEL_ID).catch(() => null);
            if (transcriptChannel) {
                const transcriptEmbed = new EmbedBuilder()
                    .setColor(PASTEL_BLUE)
                    .setDescription(`
_ _
               ❦     **𝓣ickette**  **𝓒losed**

**opened by** : ${openerUser ? `${openerUser}` : 'Unknown'}
**catered by** : ${claimedStaffText}
**closed by** : ${interaction.user}

**REASON** : ${closeReason}
_ _`);

                await transcriptChannel.send({ embeds: [transcriptEmbed], files: [transcript] });
            }

            if (openerUser) {
                const dmEmbed = new EmbedBuilder()
                    .setColor(PASTEL_BLUE)
                    .setDescription(`
_ _
               ❦     **𝓣ickette**  **𝓒losed**
-# _ _          thαnk you for trusting coαstαl cαrt !
-# _ _      your tickette wαs **cαtered** by : ${claimedStaffText}
_ _`);

                const transcriptForDm = await discordTranscripts.createTranscript(channel, {
                    limit: -1,
                    returnType: 'attachment',
                    filename: `transcript-${channel.name}.html`,
                    saveImages: true,
                    poweredBy: false
                });

                await openerUser.send({ embeds: [dmEmbed], files: [transcriptForDm] }).catch(() => {});
            }

        } catch (err) {
            console.error('Failed to generate transcript:', err);
        }

        await interaction.editReply({ content: 'Closing ticket and generating transcript...' });
        setTimeout(() => channel.delete().catch(() => {}), 3000);
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let usernameFieldVal = 'user';
    if (interaction.fields.fields.has('roblox_username')) {
        usernameFieldVal = interaction.fields.getTextInputValue('roblox_username');
    } else if (interaction.fields.fields.has('game_name')) {
        usernameFieldVal = interaction.fields.getTextInputValue('game_name');
    } else if (interaction.fields.fields.has('item_name')) {
        usernameFieldVal = interaction.fields.getTextInputValue('item_name');
    } else if (interaction.fields.fields.has('dc_username')) {
        usernameFieldVal = interaction.fields.getTextInputValue('dc_username');
    }

    const sanitizedUser = usernameFieldVal.toLowerCase().replace(/[^a-z0-9]/g, '');
    let channelPrefix = 'order';
    let categoryId = ORDER_CATEGORY_ID;

    if ([
        'modal_gamepass_ct', 'modal_viaplus_rush', 'modal_ingame_gifting', 
        'modal_viaplus_wtw', 'modal_group_payout'
    ].includes(customId)) {
        channelPrefix = 'rbx';
    } else if (customId === 'modal_topups') {
        channelPrefix = 'topup';
    } else if (customId === 'modal_dc_items') {
        channelPrefix = 'dc';
    } else if (customId === 'modal_premiums') {
        channelPrefix = 'prem';
    } else if (customId === 'modal_report') {
        channelPrefix = 'report';
        categoryId = REPORT_CATEGORY_ID;
    } else if (customId === 'modal_others') {
        channelPrefix = 'other';
        categoryId = OTHERS_CATEGORY_ID;
    }

    const ticketChannel = await interaction.guild.channels.create({
        name: `${channelPrefix}-${sanitizedUser}`,
        type: ChannelType.GuildText,
        parent: categoryId,
        permissionOverwrites: [
            { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
            { id: STAFF_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] }
        ]
    });

    const fieldsData = interaction.fields.fields.map(f => `> **${f.customId.replace(/_/g, ' ')}:** ${f.value}`).join('\n');

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
        new ButtonBuilder().setCustomId('close_ticket').setLabel('close ticket').setStyle(ButtonStyle.Secondary)
    );

    await ticketChannel.send({ content: `${interaction.user} <@&${STAFF_ROLE_ID}>`, embeds: [welcomeEmbed], components: [controlRow] });
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

    const desc = `_ _
         <:002_dns:1567870533285052498>    **sent by ɑbove** :
-# _ _        tips   ɑre   ɑppreciɑted   *!*
⎯⎯⎯⎯⎯    <:flower:1560691740456001659>    ⎯⎯⎯⎯⎯
-# _ _ totɑl ɑmount to be pɑid:   \` Ꭾ(${amount.toFixed(2)}) \`
-# _ _ pleɑse choose ɑ pɑyment method
_ _
-# _ _ extrɑ   ɑmount   sent   ɑre   tips
-# _ _ refunds      ɑre      not      ɑllowed   !
_ _`;

    const embed = new EmbedBuilder().setColor(PASTEL_BLUE).setDescription(desc);

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('mop_select_menu')
        .setPlaceholder('choose a payment method...')
        .addOptions(
            new StringSelectMenuOptionBuilder().setValue(`gcash_${amount}`).setLabel('gcash'),
            new StringSelectMenuOptionBuilder().setValue(`paymaya_${amount}`).setLabel('paymaya'),
            new StringSelectMenuOptionBuilder().setValue(`paypal_${amount}`).setLabel('paypal'),
            new StringSelectMenuOptionBuilder().setValue(`gotyme_${amount}`).setLabel('gotyme')
        );

    const row = new ActionRowBuilder().addComponents(selectMenu);
    
    // Acknowledge ephemeral response first so Discord command doesn't fail
    await interaction.reply({ content: 'Mode of payment panel generated!', flags: MessageFlags.Ephemeral });
    // Send public embed directly to the channel
    await interaction.channel.send({ embeds: [embed], components: [row] });
}

async function handleMopSelectMenu(interaction) {
    const val = interaction.values[0];
    const [mopType, amountStr] = val.split('_');
    const baseAmount = parseFloat(amountStr);

    const modal = new ModalBuilder()
        .setCustomId(`mop_tip_modal_${mopType}_${baseAmount}`)
        .setTitle('Payment Tip');
    
    const tipInput = new TextInputBuilder()
        .setCustomId('tip_input')
        .setLabel('Will you be sending a tip? Put n/a if not.')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('n/a or amount')
        .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(tipInput));
    return await interaction.showModal(modal);
}

async function handleMopModals(interaction) {
    if (interaction.customId.startsWith('mop_tip_modal_')) {
        const parts = interaction.customId.replace('mop_tip_modal_', '').split('_');
        const mopType = parts[0];

        const bannerId = '<:banner2_coastal:1567891114524938242>';
        const bannerRow = `${bannerId}${bannerId}${bannerId}${bannerId}${bannerId}${bannerId}${bannerId}`;
        
        let titleText = '';
        let accNum = '';
        let initials = '';
        let imageUrl = '';

        if (mopType === 'gcash') {
            titleText = '**ƒor gcɑsh pɑyment :**';
            accNum = '0918 455 2148';
            initials = 'R.S.';
            imageUrl = 'https://cdn.discordapp.com/attachments/1560207522521022494/1568234202489557012/Screenshot_2026-11-06_at_7.49.28_PM.png';
        } else if (mopType === 'paymaya') {
            titleText = '**ƒor pmɑyɑ pɑyment :**';
            accNum = '0918 455 2148';
            initials = 'J.S.';
            imageUrl = 'https://cdn.discordapp.com/attachments/1560207522521022494/1568234203479548026/Screenshot_2026-11-06_at_7.58.04_PM.png';
        } else if (mopType === 'paypal') {
            titleText = '**ƒor pɑypɑl pɑyment :**';
            accNum = '0918 455 2148';
            initials = 'J.S.';
            imageUrl = 'https://cdn.discordapp.com/attachments/1560207522521022494/1568234203907096698/Screenshot_2026-11-06_at_8.00.42_PM.png';
        } else if (mopType === 'gotyme') {
            titleText = '**ƒor gotyme pɑyment :**';
            accNum = '0163 811 51370';
            initials = 'J.S.';
            imageUrl = 'https://cdn.discordapp.com/attachments/1560207522521022494/1568234203034947624/Screenshot_2026-11-06_at_7.52.25_PM.png';
        }

        const desc = `_ _
     ${bannerRow}
          ${titleText}
-# _ _         qr code included. scan !

> -# _ _  <:025:1567870892082470992>  \` ${accNum}  \`
> -# _ _  <:025:1567870892082470992>  \` ${initials} \` ɑcc initiɑls

-# _ _  <:zz_blueheart3:1555584821529546752>  send **screenshot** of the receipt
-# _ _  <:zz_blueheart3:1555584821529546752>  extra ɑmount sent ɑre tippies !
_ _`;

        const embed = new EmbedBuilder()
            .setColor(PASTEL_BLUE)
            .setDescription(desc)
            .setImage(imageUrl);

        const actionButtons = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('mop_copy_num').setLabel('copy number').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('mop_send_receipt').setLabel('send receipt').setStyle(ButtonStyle.Secondary)
        );
        
        await interaction.reply({ embeds: [embed], components: [actionButtons] });
    }

    if (interaction.customId === 'mop_receipt_modal') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const receiptUrl = interaction.fields.getTextInputValue('receipt_link');

        try {
            const response = await axios.get(receiptUrl, { responseType: 'arraybuffer' });
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
                /(?:Total\s*Amount\s*Sent|Amount|Total|Paid)\s*[:#-]?\s*(?:PHP|P|₱|Ꭾ)?\s*([\d,]+\.\d{2})/i,
                /(?:PHP|P|₱|Ꭾ)\s*([\d,]+\.\d{2})/i,
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

            const nowUTC = new Date().toUTCString();

            const receiptEmbed = new EmbedBuilder()
                .setColor(PASTEL_BLUE)
                .setTitle('🧾 Receipt Details Verified')
                .addFields(
                    { name: 'Reference Number', value: extractedRef ? `\`${extractedRef}\`` : '⚠️ *Not detected clearly*', inline: true },
                    { name: 'Amount Paid', value: extractedAmount ? `₱${extractedAmount}` : '⚠️ *Not detected clearly*', inline: true },
                    { name: 'Time & Date', value: nowUTC, inline: true },
                    { name: 'Payer', value: `${interaction.user}`, inline: false }
                )
                .setImage(receiptUrl)
                .setFooter({ text: 'Notified staff successfully!' })
                .setTimestamp();

            await interaction.editReply({ 
                content: `✅ Receipt successfully verified and sent to staff <@&${STAFF_ROLE_ID}>!`, 
                embeds: [receiptEmbed] 
            });

        } catch (error) {
            console.error('OCR Modal Error:', error);
            await interaction.editReply('❌ Failed to read or fetch the image link provided. Please make sure it is a direct image URL.');
        }
    }
}

async function handleMopButtons(interaction) {
    if (interaction.customId === 'mop_copy_num') {
        const desc = interaction.message.embeds[0]?.description || '';
        const match = desc.match(/`\s*(.*?)\s*`/);
        const numberToCopy = match ? match[1] : '0918 455 2148';
        
        await interaction.reply({ content: `\`${numberToCopy}\``, flags: MessageFlags.Ephemeral });
    }

    if (interaction.customId === 'mop_send_receipt') {
        const modal = new ModalBuilder()
            .setCustomId('mop_receipt_modal')
            .setTitle('Submit Receipt Proof');

        const imageInput = new TextInputBuilder()
            .setCustomId('receipt_link')
            .setLabel('Paste direct image link of your receipt:')
            .setPlaceholder('https://cdn.discordapp.com/attachments/...')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(imageInput));
        return await interaction.showModal(modal);
    }
}

client.login(process.env.DISCORD_TOKEN);
