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
const discordTranscripts = require('discord-html-transcripts');
const axios = require('axios');
const Jimp = require('jimp');
const Tesseract = require('tesseract.js');
require('dotenv').config();

// ==========================================
// CONFIGURATION & EXPRESS SERVER SETUP
// ==========================================
const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Combined Coastal Cart Bot is online.'));
app.listen(PORT, '0.0.0.0', () => console.log(`Web server listening on port ${PORT}`));

const STAFF_ROLE_ID = '1533372358755221566';
const RESTRICTED_TICKET_ROLE_ID = '1557329338943283240';
const QUEUE_CHANNEL_ID = '1539239066049060974';
const TRANSCRIPT_CHANNEL_ID = '1507278726998524046';
const VOUCH_URL = 'https://discord.com/channels/1507214174084927498/1507271897962778706';
const BANNER_URL = 'https://cdn.discordapp.com/attachments/1553697060056866906/1554405328462938162/Coral_Reef_Sea_GIF_- *Coral_Reef_Sea_Ocean* -_Discover__Share_GIFs.gif';
const GCASH_QR_URL = 'https://cdn.discordapp.com/attachments/1553697060056866906/1554405328462938162/gcash_qr.png';
const PASTEL_BLUE = 0xAEC6CF;

// In-Memory Stores
let queueCounter = 1;
const queueStore = new Map();
const ticketStore = new Map();

// Helper Functions
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

function isStaff(member) {
    return member && member.roles && member.roles.cache.has(STAFF_ROLE_ID);
}

// ==========================================
// BOT INITIALIZATION & REGISTER COMMANDS
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
    // 1. /queue-list
    new SlashCommandBuilder()
        .setName('queue-list')
        .setDescription('Create a new queue tracker for an order')
        .addUserOption(opt => opt.setName('buyer').setDescription('Select the buyer').setRequired(true))
        .addStringOption(opt => opt.setName('item').setDescription('Item bought').setRequired(true))
        .addStringOption(opt => opt.setName('info').setDescription('Item info').setRequired(true))
        .addStringOption(opt => opt.setName('payment').setDescription('Payment method').setRequired(true))
        .addStringOption(opt => opt.setName('price').setDescription('Price paid').setRequired(true)),

    // 2. /ticket-setup
    new SlashCommandBuilder()
        .setName('ticket-setup')
        .setDescription('Sends the main ticket setup panel'),

    // 3. /mop
    new SlashCommandBuilder()
        .setName('mop')
        .setDescription('Generate mode of payment details for a buyer')
        .addNumberOption(opt => opt.setName('amount').setDescription('Amount the buyer needs to pay').setRequired(true))
].map(cmd => cmd.toJSON());

// ==========================================
// MAIN INTERACTION ROUTER
// ==========================================
client.on('interactionCreate', async (interaction) => {
    try {
        // --- Slash Commands ---
        if (interaction.isChatInputCommand()) {
            switch (interaction.commandName) {
                case 'queue-list':
                    return await handleQueueListCommand(interaction);
                case 'ticket-setup':
                    return await handleTicketSetupCommand(interaction);
                case 'mop':
                    return await handleMopCommand(interaction);
                default:
                    break;
            }
        }

        // --- Button Interactions ---
        if (interaction.isButton()) {
            // Ticket Buttons
            if (interaction.customId === 'create_ticket') return await handleCreateTicketButton(interaction);
            if (interaction.customId.startsWith('claim_ticket_')) return await handleClaimTicketButton(interaction);
            if (interaction.customId.startsWith('close_ticket_')) return await handleCloseTicketButton(interaction);
            
            // Queue Buttons
            if (interaction.customId.startsWith('mark_completed_')) return await handleQueueCompleteButton(interaction);

            // MOP Buttons
            if (interaction.customId.startsWith('mop_select_')) return await handleMopSelectButton(interaction);
            if (interaction.customId.startsWith('mop_notip_')) return await handleMopNoTipButton(interaction);
            if (interaction.customId.startsWith('mop_addtip_')) return await handleMopAddTipButton(interaction);
            if (interaction.customId === 'copy_maya_num' || interaction.customId === 'copy_gotyme_num') {
                const number = interaction.customId === 'copy_maya_num' ? '09184552148' : '016381151370';
                return await interaction.reply({ content: `\`${number}\``, ephemeral: true });
            }
        }

        // --- Modal Submissions ---
        if (interaction.isModalSubmit()) {
            if (interaction.customId.startsWith('ticket_close_modal_')) return await handleTicketCloseModalSubmit(interaction);
            if (interaction.customId.startsWith('mop_tip_modal_')) return await handleMopTipModalSubmit(interaction);
        }
    } catch (err) {
        console.error('Error handling interaction:', err);
    }
});

// ==========================================
// COMMAND HANDLER 1: /queue-list
// ==========================================
async function handleQueueListCommand(interaction) {
    if (!isStaff(interaction.member)) {
        return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
    }

    const buyer = interaction.options.getUser('buyer');
    const item = interaction.options.getString('item');
    const info = interaction.options.getString('info');
    const payment = interaction.options.getString('payment');
    const price = interaction.options.getString('price');

    const queueId = queueCounter++;
    const formattedId = String(queueId).padStart(3, '0');

    const embed = new EmbedBuilder()
        .setColor(PASTEL_BLUE)
        .setTitle(`ORDER QUEUE #${formattedId}`)
        .setDescription(
`**Buyer:** ${buyer}
**Item:** ${item}
**Info:** ${info}
**Payment Method:** ${payment}
**Price Paid:** ₱${price}
**Status:** Pending Processing`
        )
        .setFooter({ text: `Created on ${getGMT8Time()}` });

    const completeBtn = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`mark_completed_${queueId}`)
            .setLabel('Mark as Completed')
            .setStyle(ButtonStyle.Success)
    );

    const channel = interaction.guild.channels.cache.get(QUEUE_CHANNEL_ID) || interaction.channel;
    const msg = await channel.send({ embeds: [embed], components: [completeBtn] });

    queueStore.set(queueId, { buyerId: buyer.id, item, info, payment, price, msgId: msg.id });

    await interaction.reply({ content: `Queue item #${formattedId} created successfully!`, ephemeral: true });
}

async function handleQueueCompleteButton(interaction) {
    if (!isStaff(interaction.member)) {
        return interaction.reply({ content: 'Only staff can complete queue items.', ephemeral: true });
    }

    const queueId = parseInt(interaction.customId.split('_')[2]);
    const data = queueStore.get(queueId);

    const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
        .setColor(0x77DD77)
        .setDescription(interaction.message.embeds[0].description.replace('Pending Processing', `Completed by ${interaction.user}`));

    await interaction.update({ embeds: [updatedEmbed], components: [] });
}

// ==========================================
// COMMAND HANDLER 2: /ticket-setup
// ==========================================
async function handleTicketSetupCommand(interaction) {
    // Defer reply immediately to prevent "Application did not respond"
    await interaction.deferReply({ ephemeral: true });

    if (!isStaff(interaction.member)) {
        return interaction.editReply({ content: 'You do not have permission to use this command.' });
    }

    const embed = new EmbedBuilder()
        .setColor(PASTEL_BLUE)
        .setTitle('Coastal Cart Support Tickets')
        .setDescription('Click the button below to open a private ticket with staff.')
        .setImage(BANNER_URL);

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('create_ticket')
            .setLabel('Open Ticket')
            .setStyle(ButtonStyle.Primary)
    );

    // Send the panel directly into the channel
    await interaction.channel.send({ embeds: [embed], components: [row] });

    // Confirm deployment
    await interaction.editReply({ content: 'Ticket setup panel deployed!' });
}

async function handleCreateTicketButton(interaction) {
    // Check if member has restricted role
    if (interaction.member.roles.cache.has(RESTRICTED_TICKET_ROLE_ID)) {
        return await interaction.reply({
            content: `You cannot open a ticket right now. You must vouch your previous item(s) in [vouch-items](${VOUCH_URL}) to regain access to create a ticket!`,
            ephemeral: true
        });
    }

    const channelName = `ticket-${interaction.user.username}`.toLowerCase();
    
    const ticketChannel = await interaction.guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        permissionOverwrites: [
            { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
            { id: STAFF_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
        ]
    });

    ticketStore.set(ticketChannel.id, { ownerId: interaction.user.id, claimedBy: null });

    const embed = new EmbedBuilder()
        .setColor(PASTEL_BLUE)
        .setTitle('Ticket Opened')
        .setDescription(`Hello ${interaction.user}, please describe your issue. A staff member will assist you shortly.`);

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`claim_ticket_${ticketChannel.id}`).setLabel('Claim Ticket').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`close_ticket_${ticketChannel.id}`).setLabel('Close Ticket').setStyle(ButtonStyle.Danger)
    );

    await ticketChannel.send({ embeds: [embed], components: [row] });
    await interaction.reply({ content: `Ticket created: ${ticketChannel}`, ephemeral: true });
}

async function handleClaimTicketButton(interaction) {
    if (!isStaff(interaction.member)) {
        return interaction.reply({ content: 'Only staff can claim tickets.', ephemeral: true });
    }

    const data = ticketStore.get(interaction.channel.id);
    if (data) data.claimedBy = interaction.user.id;

    await interaction.reply({ content: `Ticket claimed by ${interaction.user}.` });
}

async function handleCloseTicketButton(interaction) {
    const modal = new ModalBuilder()
        .setCustomId(`ticket_close_modal_${interaction.channel.id}`)
        .setTitle('Close Ticket');

    const reasonInput = new TextInputBuilder()
        .setCustomId('close_reason')
        .setLabel('Reason for closing')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
    await interaction.showModal(modal);
}

async function handleTicketCloseModalSubmit(interaction) {
    const reason = interaction.fields.getTextInputValue('close_reason');
    await interaction.reply({ content: 'Closing ticket and generating transcript...' });

    const transcript = await discordTranscripts.createTranscript(interaction.channel);
    const transcriptChannel = interaction.guild.channels.cache.get(TRANSCRIPT_CHANNEL_ID);

    if (transcriptChannel) {
        await transcriptChannel.send({
            content: `Transcript for ${interaction.channel.name} | Closed by: ${interaction.user} | Reason: ${reason}`,
            files: [transcript]
        });
    }

    setTimeout(() => interaction.channel.delete().catch(() => {}), 3000);
}

// ==========================================
// COMMAND HANDLER 3: /mop
// ==========================================
async function handleMopCommand(interaction) {
    if (!isStaff(interaction.member)) {
        return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
    }

    const amount = interaction.options.getNumber('amount');

    const embed = new EmbedBuilder()
        .setColor(PASTEL_BLUE)
        .setTitle('Select Mode of Payment')
        .setDescription(`Amount Due: **₱${amount}**\nSelect your preferred payment method below:`);

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`mop_select_gcash_${amount}`).setLabel('GCash').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`mop_select_maya_${amount}`).setLabel('Maya').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`mop_select_gotyme_${amount}`).setLabel('GoTyme').setStyle(ButtonStyle.Secondary)
    );

    await interaction.reply({ embeds: [embed], components: [row] });
}

async function handleMopSelectButton(interaction) {
    const [, , mopType, amount] = interaction.customId.split('_');

    const embed = new EmbedBuilder()
        .setColor(PASTEL_BLUE)
        .setTitle('Add a Tip?')
        .setDescription(`Would you like to add a tip to your payment of **₱${amount}**?`);

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`mop_notip_${mopType}_${amount}`).setLabel('No Tip').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`mop_addtip_${mopType}_${amount}`).setLabel('Add Tip').setStyle(ButtonStyle.Secondary)
    );

    await interaction.update({ embeds: [embed], components: [row] });
}

async function handleMopNoTipButton(interaction) {
    const [, , mopType, amount] = interaction.customId.split('_');
    await renderMopEmbed(interaction, mopType, parseFloat(amount), 0);
}

async function handleMopAddTipButton(interaction) {
    const [, , mopType, amount] = interaction.customId.split('_');

    const modal = new ModalBuilder()
        .setCustomId(`mop_tip_modal_${mopType}_${amount}`)
        .setTitle('Enter Tip Amount');

    const tipInput = new TextInputBuilder()
        .setCustomId('tip_amount')
        .setLabel('Tip Amount (₱)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(tipInput));
    await interaction.showModal(modal);
}

async function handleMopTipModalSubmit(interaction) {
    const [, , , mopType, amountStr] = interaction.customId.split('_');
    const tip = parseFloat(interaction.fields.getTextInputValue('tip_amount')) || 0;
    const baseAmount = parseFloat(amountStr);

    await renderMopEmbed(interaction, mopType, baseAmount, tip);
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

    const replyOptions = { embeds: [embed] };
    if (componentsRow) replyOptions.components = [componentsRow];

    if (interaction.isModalSubmit()) {
        await interaction.reply(replyOptions);
    } else if (interaction.replied || interaction.deferred) {
        await interaction.followUp(replyOptions);
    } else {
        await interaction.reply(replyOptions);
    }
}

// ==========================================
// RECEIPT AUTO-READER (OCR) MODULE
// ==========================================
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    if (message.attachments.size > 0) {
        const attachment = message.attachments.first();
        if (attachment.contentType && attachment.contentType.startsWith('image/')) {
            try {
                const response = await axios.get(attachment.url, { responseType: 'arraybuffer' });
                const imageBuffer = Buffer.from(response.data, 'binary');

                const { data: { text } } = await Tesseract.recognize(imageBuffer, 'eng');
                
                if (text.toLowerCase().includes('amount') || text.toLowerCase().includes('ref') || text.toLowerCase().includes('successful')) {
                    await message.reply('payment received. thank you!');
                }
            } catch (err) {
                console.error('OCR Processing Error:', err);
            }
        }
    }
});

// ==========================================
// CLIENT READY & COMMAND REGISTRATION
// ==========================================
client.once('ready', async () => {
    console.log(`Bot online as ${client.user.tag}`);

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        console.log('Registering slash commands...');
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands }
        );
        console.log('Slash commands registered successfully!');
    } catch (error) {
        console.error('Failed to register commands:', error);
    }
});

client.login(process.env.DISCORD_TOKEN);
