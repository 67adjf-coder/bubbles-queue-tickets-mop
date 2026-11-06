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
const TARGET_QUEUE_CHANNEL_ID = '1542629404973211698'; // Queue channel
const PASTEL_BLUE = 0xAEC6CF; 

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
        .setName('queue')
        .setDescription('Create a new queue order tracker')
        .addChannelOption(opt => opt.setName('ticket_channel').setDescription('Ticket channel where order was placed').setRequired(true))
        .addStringOption(opt => opt.setName('item_name').setDescription('Item name').setRequired(true))
        .addStringOption(opt => opt.setName('qty').setDescription('Quantity').setRequired(true))
        .addUserOption(opt => opt.setName('staff').setDescription('Staff who used the /queue command').setRequired(true))
        .addStringOption(opt => opt.setName('mop').setDescription('Mode of payment info').setRequired(true))
        .addStringOption(opt => opt.setName('amount_paid').setDescription('Amount sent').setRequired(true)),

    new SlashCommandBuilder()
        .setName('mop')
        .setDescription('Generate mode of payment details for a buyer')
        .addNumberOption(opt => opt.setName('amount').setDescription('Total amount to be paid').setRequired(true))
].map(cmd => cmd.toJSON());

client.once('ready', async () => {
    console.log(`[Discord Gateway] Logged in as ${client.user.tag}!`);

    client.user.setPresence({
        activities: [{ name: 'shoreline orders', type: ActivityType.Watching }],
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
        if (interaction.isChatInputCommand() && interaction.commandName === 'queue') {
            return handleQueueCommand(interaction);
        }
        if (interaction.isStringSelectMenu() && interaction.customId === 'queue_status_menu') {
            return handleQueueMenu(interaction);
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
        if (interaction.isModalSubmit() && interaction.customId.startsWith('mop_tip_modal_')) {
            return handleMopModals(interaction);
        }
    } catch (err) {
        console.error('Unhandled interaction error:', err);
    }
});

// ==========================================
// RECEIPT AUTO-READER (OCR) MODULE FOR MOP
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

            const timestamp = new Date().toUTCString();

            const receiptEmbed = new EmbedBuilder()
                .setColor(PASTEL_BLUE)
                .setTitle('🧾 Receipt Proof Verified')
                .addFields(
                    { name: 'Reference Number', value: extractedRef ? `\`${extractedRef}\`` : '⚠️ *Not detected clearly*', inline: true },
                    { name: 'Amount Paid', value: extractedAmount ? `₱${extractedAmount}` : '⚠️ *Not detected clearly*', inline: true },
                    { name: 'Time Sent', value: timestamp, inline: true },
                    { name: 'Payer', value: `${message.author}`, inline: false }
                )
                .setImage(attachment.url)
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
// 1. QUEUE COMMAND MODULE
// ==========================================
function getQueueDescription(buyerTag, qty, itemName, mopInfo, amount, staffUser, statusLine) {
    return `_ _
<:009:1568197445698064395> <:010:1568197472487088169>  ** by the ꗏeαshore ** !
-# _ _          hιgh tιdes of grαtιtude
~~                                      ~~
-# _ _       <:002:1568197332883742810> : ${buyerTag}
-# _ _  <:glow_dots:1560696020852019310> # ${qty}  oƒ  ${itemName}
-# _ _  <:glow_dots:1560696020852019310> vιa : ${mopInfo}
-# _ _  <:glow_dots:1560696020852019310> ꝓ ${amount} sᧉnt vιa mop
-# _ _   ιtem cαtered by : <@${staffUser.id}>
~~                                      ~~
-# _ _   ${statusLine}
_ _`;
}

function buildQueueComponents(isDisabled = false) {
    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('queue_status_menu')
        .setPlaceholder('select queue status...')
        .setDisabled(isDisabled)
        .addOptions(
            new StringSelectMenuOptionBuilder().setValue('noted').setLabel('noted').setDescription('Set status to noted (Layout 1)'),
            new StringSelectMenuOptionBuilder().setValue('processing').setLabel('processing').setDescription('Set status to processing (Layout 2)'),
            new StringSelectMenuOptionBuilder().setValue('completed').setLabel('completed').setDescription('Set status to completed (Layout 3 & disable menu)')
        );

    const row1 = new ActionRowBuilder().addComponents(selectMenu);
    
    // Grey button beside/below with only the spiral emoji (always disabled)
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('queue_spiral_dummy')
            .setEmoji('<a:spiral:1555857356082909315>')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true)
    );

    return [row1, row2];
}

async function handleQueueCommand(interaction) {
    if (!isStaff(interaction.member)) {
        return interaction.reply({ content: 'You do not have permission to use this command.', flags: MessageFlags.Ephemeral });
    }

    const ticketChannel = interaction.options.getChannel('ticket_channel');
    const itemName = interaction.options.getString('item_name');
    const qty = interaction.options.getString('qty');
    const staff = interaction.options.getUser('staff');
    const mop = interaction.options.getString('mop');
    const amountPaid = interaction.options.getString('amount_paid');

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const queueChannel = await client.channels.fetch(TARGET_QUEUE_CHANNEL_ID).catch(() => null);
    if (!queueChannel) {
        return interaction.editReply({ content: 'Error: Target queue channel could not be found.' });
    }

    const initialStatus = 'ιtem sent to lιneup <:001_dns:1567870463366004756>';
    const description = getQueueDescription(ticketChannel.toString(), qty, itemName, mop, amountPaid, staff, initialStatus);
    
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

    let newStatusLine = '';
    let isCompleted = false;

    if (selectedValue === 'noted') {
        newStatusLine = 'your order ιs noted by ownιe <:001_dns:1567870463366004756>';
    } else if (selectedValue === 'processing') {
        newStatusLine = 'your order ιs beιng processed <:001_dns:1567870463366004756>';
    } else if (selectedValue === 'completed') {
        newStatusLine = 'your order ιs now delιvered <:001_dns:1567870463366004756>';
        isCompleted = true;
    }

    const updatedDesc = embed.description.replace(/-\# _ _\s+.*(<:001_dns:.*)?$/, `-# _ _   ${newStatusLine}`);
    const updatedEmbed = EmbedBuilder.from(embed).setDescription(updatedDesc);
    const newComponents = buildQueueComponents(isCompleted);

    await interaction.update({ embeds: [updatedEmbed], components: newComponents });
}


// ==========================================
// 2. MODE OF PAYMENT COMMAND MODULE (/mop)
// ==========================================
async function handleMopCommand(interaction) {
    if (!isStaff(interaction.member)) {
        return interaction.reply({ content: 'You do not have permission to use this command.', flags: MessageFlags.Ephemeral });
    }

    const amount = interaction.options.getNumber('amount');

    const desc = `_ _
<:002_dns:1567870533285052498> sent by ɑbove :
-# _ _   tips ɑre ɑppreciɑted !
~~         ~~ <:flower:1560691740456001659> ~~         ~~
-# _ _ totɑl ɑmount to be pɑid: ₱ ${amount.toFixed(2)}
-# _ _ pleɑse choose ɑ pɑyment method
_ _
-# _ _ extrɑ ɑmount sent ɑre tips
-# _ _ refunds  ɑre not ɑllowed !
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
    await interaction.reply({ embeds: [embed], components: [row] });
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
        const baseAmount = parseFloat(parts[1]);

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

        // All buttons must be grey (Secondary)
        const actionButtons = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('mop_copy_num').setLabel('copy number').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('mop_send_receipt').setLabel('send receipt').setStyle(ButtonStyle.Secondary)
        );
        
        await interaction.reply({ embeds: [embed], components: [actionButtons] });
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
        await interaction.reply({ 
            content: `Please upload your receipt screenshot directly in this channel and mention <@${client.user.id}> so I can automatically read and verify your transaction details for the staff (<@&${STAFF_ROLE_ID}>)!`, 
            flags: MessageFlags.Ephemeral 
        });
    }
}

client.login(process.env.DISCORD_TOKEN);
