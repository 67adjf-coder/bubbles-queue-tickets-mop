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
const { createWorker } = require('tesseract.js');
const discordTranscripts = require('discord-html-transcripts');
require('dotenv').config();

// --- HTTP SERVER FOR HOSTING HEALTH CHECKS ---
const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Combined Coastal Cart Bot is online.'));
app.listen(PORT, '0.0.0.0', () => console.log(`Web server listening on port ${PORT}`));

// --- CONFIGURATION CONSTANTS ---
const STAFF_ROLE_ID = '1533372358755221566';
const QUEUE_CHANNEL_ID = '1539239066049060974';
const CATEGORY_ID = '1539233770035617904';
const TRANSCRIPT_CHANNEL_ID = '1507278726998524046';
const VOUCH_URL = 'https://discord.com/channels/1507214174084927498/1507271897962778706';
const BANNER_URL = 'https://cdn.discordapp.com/attachments/1553697060056866906/1554405328462938162/Coral_Reef_Sea_GIF_-_Coral_Reef_Sea_Ocean_-_Discover__Share_GIFs.gif?ex=6abf6745&is=6abe15c5&hm=7248fb3fe9a07a4857b393db5d6a767808fb7d12d910cd4e1bcd95281abb5a18';

const PASTEL_BLUE = 0xAEC6CF;
const PASTEL_GREEN = 0x77DD77;

// --- IN-MEMORY STORES ---
let queueCounter = 1;
const queueStore = new Map();
const activeMopSessions = new Map();
const ticketStore = new Map(); // Stores { buyerId, claimedByStaffId }

// --- HELPER FUNCTIONS ---
function getGMT8Time() {
    const options = {
        timeZone: 'Asia/Manila',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    };
    return new Intl.DateTimeFormat('en-US', options).format(new Date());
}

function getGMT8Timestamp() {
    return new Date().toLocaleString('en-US', {
        timeZone: 'Asia/Manila',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
    }) + ' gmt+8';
}

async function generateQRBuffer(text) {
    return await QRCode.toBuffer(text, { margin: 1, width: 300 });
}

function isStaff(member, user) {
    if (user && user.id === STAFF_ROLE_ID) return true;
    return member && member.roles && member.roles.cache.has(STAFF_ROLE_ID);
}

function buildQueueEmbed(guildId, ticketChannelId, queueNum, buyerId, item, info, payment, price, staffId, statusText) {
    const description = 
`_ _
     𓂃 𓈒𓏸‪‪ 𓇼    [ **tid**__a__**l** **w**~~a~~***ves*** ](https://discord.com/channels/\({guildId}/\){ticketChannelId})  ＃ __ ${queueNum} __
~~                                                                                ~~
<:blue:1554781672992407552>    <@${buyerId}>
> \({item}  <:hearty:1554781762813558804>\){info}
> \({payment}  <:hearty:1554781762813558804>\){price}
_ _
-# _ _        sea shore  ~~        ~~  <@${staffId}>
-# _ _        **\({statusText}**\){getGMT8Time()}
~~                                                                                ~~
_ _`;

    return new EmbedBuilder()
        .setColor(PASTEL_BLUE)
        .setDescription(description);
}

// --- DISCORD CLIENT & SLASH COMMAND DEFINITIONS ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

const commands = [
    // Command 1: /queue-list
    new SlashCommandBuilder()
        .setName('queue-list')
        .setDescription('Create a new queue tracker for an order')
        .addUserOption(opt => opt.setName('buyer').setDescription('Select the buyer').setRequired(true))
        .addStringOption(opt => opt.setName('item').setDescription('Item bought').setRequired(true))
        .addStringOption(opt => opt.setName('info').setDescription('Item info').setRequired(true))
        .addStringOption(opt => opt.setName('payment').setDescription('Payment method').setRequired(true))
        .addStringOption(opt => opt.setName('price').setDescription('Price paid').setRequired(true)),

    // Command 2: /ticket-setup
    new SlashCommandBuilder()
        .setName('ticket-setup')
        .setDescription('Sends the main ticket setup panel'),

    // Command 3: /mop
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
        console.log('Successfully registered all 3 slash commands globally!');
    } catch (err) {
        console.error('Error registering slash commands:', err);
    }
});

// --- MAIN INTERACTION EVENT HANDLER ---
client.on('interactionCreate', async (interaction) => {

    // ==========================================
    // 1. SLASH COMMANDS ROUTING
    // ==========================================
    if (interaction.isChatInputCommand()) {

        // --- COMMAND 1: /queue-list ---
        if (interaction.commandName === 'queue-list') {
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
> track your order [here](https://discord.com/channels/\({interaction.guildId}/\){QUEUE_CHANNEL_ID}) ! 𓆉
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
            return;
        }

        // --- COMMAND 2: /ticket-setup ---
        if (interaction.commandName === 'ticket-setup') {
            const embed = new EmbedBuilder()
                .setColor(PASTEL_BLUE)
                .setDescription(
`_ _
# _ _      tick__kette__ b*oo*th <:butterfly:1554370425587245066>
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
                new ButtonBuilder().setCustomId('btn_order').setLabel('Order').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('btn_report').setLabel('Report').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId('btn_others').setLabel('Others').setStyle(ButtonStyle.Secondary)
            );

            await interaction.reply({ content: 'Ticket panel sent to channel!', ephemeral: true });
            await interaction.channel.send({ embeds: [embed], components: [row] });
            return;
        }

        // --- COMMAND 3: /mop ---
        if (interaction.commandName === 'mop') {
            if (!isStaff(interaction.member, interaction.user)) {
                return interaction.reply({ content: 'Only staff can use this command.', ephemeral: true });
            }

            const amount = interaction.options.getNumber('amount');
            const sessionId = `session_${interaction.id}`;
            activeMopSessions.set(sessionId, { amount, channelId: interaction.channelId });

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
                    .setCustomId(`proceed_payment_${sessionId}`)
                    .setEmoji('')
                    .setStyle(ButtonStyle.Primary)
            );

            await interaction.reply({ embeds: [mainEmbed], components: [row] });
            return;
        }
    }

    // ==========================================
    // 2. BUTTON INTERACTION ROUTING
    // ==========================================
    if (interaction.isButton()) {
        const customId = interaction.customId;

        // --- QUEUE LIST BUTTONS ---
        if (customId.startsWith('queue_')) {
            if (!isStaff(interaction.member, interaction.user)) {
                return interaction.reply({ content: 'Only staff can update queue status.', ephemeral: true });
            }

            const [, action, ticketChannelId] = customId.split('_');
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

            let statusLabel = '';
            if (action === 'noted') statusLabel = 'NOTED';
            else if (action === 'proc') statusLabel = 'PROCESSING';
            else if (action === 'comp') statusLabel = 'COMPLETED';

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
                    if (btn.customId === customId) btnBuilder.setDisabled(true);
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
            return;
        }

        // --- TICKET BOOTH PANEL BUTTONS ---
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

            // Save claiming staff ID
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

            const modal = new ModalBuilder()
                .setCustomId('modal_close_reason')
                .setTitle('Close Ticket');

            const reasonInput = new TextInputBuilder()
                .setCustomId('close_reason')
                .setLabel('Reason for closing ticket:')
                .setPlaceholder('Enter the reason for closing this ticket...')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true);

            modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
            return await interaction.showModal(modal);
        }

        // --- MOP BUTTONS ---
        if (customId.startsWith('proceed_payment_')) {
            const sessionId = customId.replace('proceed_payment_', '');
            const sessionData = activeMopSessions.get(sessionId);

            if (!sessionData) {
                return interaction.reply({ content: 'Session expired. Please run /mop again.', ephemeral: true });
            }

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`mop_select_gcash_${sessionId}`).setLabel('GCash').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`mop_select_maya_${sessionId}`).setLabel('Maya').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`mop_select_gotyme_${sessionId}`).setLabel('GoTyme').setStyle(ButtonStyle.Secondary)
            );

            await interaction.reply({
                content: `Select your preferred payment method (Amount: ₱${sessionData.amount}):`,
                components: [row],
                ephemeral: true
            });
            return;
        }

        if (customId.startsWith('mop_select_')) {
            const [, , type, sessionId] = customId.split('_');

            if (type === 'gcash') {
                const modal = new ModalBuilder().setCustomId(`tip_modal_${sessionId}`).setTitle('Add a Tip?');
                const tipInput = new TextInputBuilder().setCustomId('tip_amount').setLabel('Tip Amount in PHP (Enter 0 for no tip)').setStyle(TextInputStyle.Short).setValue('0').setRequired(true);
                modal.addComponents(new ActionRowBuilder().addComponents(tipInput));
                await interaction.showModal(modal);
            } else if (type === 'maya') {
                await renderMopEmbed(interaction, 'maya', sessionId, 10);
            } else if (type === 'gotyme') {
                await renderMopEmbed(interaction, 'gotyme', sessionId, 10);
            }
            return;
        }

        if (customId === 'copy_maya_num') {
            await interaction.reply({ content: '`09184552148`', ephemeral: true });
            return;
        }
        if (customId === 'copy_gotyme_num') {
            await interaction.reply({ content: '`016381151370`', ephemeral: true });
            return;
        }
    }

    // ==========================================
    // 3. MODAL SUBMIT ROUTING
    // ==========================================
    if (interaction.isModalSubmit()) {

        // --- MOP GCASH TIP MODAL ---
        if (interaction.customId.startsWith('tip_modal_')) {
            const sessionId = interaction.customId.replace('tip_modal_', '');
            const tipVal = parseFloat(interaction.fields.getTextInputValue('tip_amount')) || 0;
            await renderMopEmbed(interaction, 'gcash', sessionId, tipVal);
            return;
        }

        // --- TICKET CREATION MODALS ---
        if (['modal_order', 'modal_report', 'modal_others'].includes(interaction.customId)) {
            await interaction.reply({ content: 'creating your ticket... please be patient', ephemeral: true });

            const usernameSanitized = interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '');
            let channelPrefix = '';
            let formFields = [];

            if (interaction.customId === 'modal_order') {
                channelPrefix = 'order';
                formFields = [
                    { name: 'Product Name', value: interaction.fields.getTextInputValue('product_name') },
                    { name: 'Quantity', value: interaction.fields.getTextInputValue('quantity') },
                    { name: 'Details', value: interaction.fields.getTextInputValue('details') }
                ];
            } else if (interaction.customId === 'modal_report') {
                channelPrefix = 'report';
                formFields = [
                    { name: 'Product Name', value: interaction.fields.getTextInputValue('product_name') },
                    { name: 'Months Purchased', value: interaction.fields.getTextInputValue('months_purchased') },
                    { name: 'Item Issue', value: interaction.fields.getTextInputValue('item_issue') },
                    { name: 'Vouch Link', value: interaction.fields.getTextInputValue('vouch_link') }
                ];
            } else if (interaction.customId === 'modal_others') {
                channelPrefix = 'others';
                formFields = [
                    { name: 'Reason for opening a ticket', value: interaction.fields.getTextInputValue('reason') }
                ];
            }

            const channelName = `\({channelPrefix}-\){usernameSanitized}`;

            setTimeout(async () => {
                try {
                    const ticketChannel = await interaction.guild.channels.create({
                        name: channelName,
                        type: ChannelType.GuildText,
                        parent: CATEGORY_ID,
                        permissionOverwrites: [
                            { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                            { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
                            { id: STAFF_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
                        ]
                    });

                    // Store buyer ID mapped to ticket channel ID
                    ticketStore.set(ticketChannel.id, { buyerId: interaction.user.id, claimedByStaffId: null });

                    await interaction.editReply({ content: `Your ticket has been created: <#${ticketChannel.id}>` });

                    const ticketEmbed = new EmbedBuilder()
                        .setColor(PASTEL_BLUE)
                        .setTitle(`Ticket Opened by ${interaction.user.tag}`)
                        .addFields(formFields)
                        .setImage(BANNER_URL);

                    const ticketButtons = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId('claim_ticket').setLabel('Claim').setStyle(ButtonStyle.Success),
                        new ButtonBuilder().setCustomId('close_ticket').setLabel('Close').setStyle(ButtonStyle.Danger)
                    );

                    await ticketChannel.send({
                        content: `<@&\({STAFF_ROLE_ID}>\){interaction.user}`,
                        embeds: [ticketEmbed],
                        components: [ticketButtons]
                    });
                } catch (err) {
                    console.error('Failed to create ticket channel:', err);
                }
            }, 5000);
            return;
        }

        // --- SUBMIT TICKET CLOSE REASON MODAL ---
        if (interaction.customId === 'modal_close_reason') {
            const closeReason = interaction.fields.getTextInputValue('close_reason');
            const channel = interaction.channel;
            const closedByStaffId = interaction.user.id;

            const ticketData = ticketStore.get(channel.id) || {};
            const buyerId = ticketData.buyerId || 'Unknown Buyer';
            const claimedByStaffId = ticketData.claimedByStaffId ? `<@${ticketData.claimedByStaffId}>` : 'None';

            await interaction.reply('ticket will be closed in 10 mins, generating transcript!');

            setTimeout(async () => {
                try {
                    // Generate transcript
                    const transcriptFile = await discordTranscripts.createTranscript(channel, {
                        limit: -1,
                        fileName: `transcript-${channel.name}.html`,
                        poweredBy: false
                    });

                    // Custom Pastel Blue Layout Embed
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

                    // Send to Transcript Channel
                    const transcriptChannel = interaction.guild.channels.cache.get(TRANSCRIPT_CHANNEL_ID);
                    if (transcriptChannel) {
                        await transcriptChannel.send({ embeds: [transcriptEmbed], files: [transcriptFile] });
                    }

                    // Send to Buyer DMs
                    try {
                        const buyerUser = await client.users.fetch(buyerId).catch(() => null);
                        if (buyerUser) {
                            await buyerUser.send({ embeds: [transcriptEmbed], files: [transcriptFile] });
                        }
                    } catch (dmErr) {
                        console.error('Could not send DM to buyer:', dmErr);
                    }

                    // Cleanup store and delete channel
                    ticketStore.delete(channel.id);
                    await channel.delete();

                } catch (err) {
                    console.error('Error during ticket closure and transcript generation:', err);
                }
            }, 600000); // 10 minute delay
            return;
        }
    }
});

// --- HELPER FUNCTION FOR MOP RENDER & RECEIPT LISTENER ---
async function renderMopEmbed(interaction, mopType, sessionId, feeOrTip = 0) {
    const sessionData = activeMopSessions.get(sessionId);
    if (!sessionData) return interaction.reply({ content: 'Session expired.', ephemeral: true });

    const totalAmount = sessionData.amount + feeOrTip;
    let headerTitle = '';
    let accountNum = '';
    let qrPayload = '';
    let componentsRow = null;

    if (mopType === 'gcash') {
        headerTitle = '                   𝓖ca**s**h   (  001  )   ';
        accountNum = '0918  455  2148';
        qrPayload = `09184552148`;
    } else if (mopType === 'maya') {
        headerTitle = '                   𝓜a**y**a   (  002  )   ';
        accountNum = '0918  455  2148';
        qrPayload = `09184552148`;
        componentsRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('copy_maya_num').setLabel('copy number').setStyle(ButtonStyle.Secondary)
        );
    } else if (mopType === 'gotyme') {
        headerTitle = '                   𝓖oty**m**e   (  003  )   ';
        accountNum = '0163 8115 1370';
        qrPayload = `016381151370`;
        componentsRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('copy_gotyme_num').setLabel('copy number').setStyle(ButtonStyle.Secondary)
        );
    }

    const qrBuffer = await generateQRBuffer(qrPayload);
    const attachment = new AttachmentBuilder(qrBuffer, { name: 'qr_code.png' });

    const embed = new EmbedBuilder()
        .setColor(PASTEL_BLUE)
        .setDescription(
`_ _
# _ _     ${headerTitle}
~~                                                                        ~~
          \`   ${accountNum}   \`
~~                                                                        ~~
-# _ _                **𝓢can the qr code below!**
_ _`
        )
        .setImage('attachment://qr_code.png');

    const replyOptions = {
        content: `Payment details for **\({mopType.toUpperCase()}** (Total: **₱\){totalAmount}**):`,
        embeds: [embed],
        files: [attachment]
    };

    if (componentsRow) replyOptions.components = [componentsRow];

    await interaction.channel.send(replyOptions);

    if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: 'Payment details generated above!', components: [] });
    } else {
        await interaction.reply({ content: 'Payment details generated above!', ephemeral: true });
    }

    startReceiptListener(interaction.channel, mopType, totalAmount);
}

function startReceiptListener(channel, mopType, expectedAmount) {
    const filter = m => !m.author.bot && m.attachments.size > 0;
    const collector = channel.createMessageCollector({ filter, time: 600000 });

    collector.on('collect', async (message) => {
        const attachment = message.attachments.first();
        if (!attachment.contentType || !attachment.contentType.startsWith('image/')) return;

        const processingMsg = await message.reply('🔍 *Reading screenshot receipt details...*');

        try {
            const worker = await createWorker('eng');
            const ret = await worker.recognize(attachment.url);
            await worker.terminate();

            const text = ret.data.text;
            let refNo = 'Unparsed';

            const refMatch = text.match(/(?:ref|reference|no|txn)?[\s#:]*(\d{8,16})/i);
            if (refMatch) refNo = refMatch[1];

            const receiptEmbed = new EmbedBuilder()
                .setColor(PASTEL_BLUE)
                .setDescription(
`_ _
**price paid** : ₱${expectedAmount}
**ref no.** : || ${refNo} ||
**date and time** : \` ${getGMT8Timestamp()} \`
_ _`
                );

            await processingMsg.delete().catch(() => {});
            const verifyMsg = await channel.send({
                content: `<@&${STAFF_ROLE_ID}> Please verify payment! Reply with **confirmed** to approve.`,
                embeds: [receiptEmbed]
            });

            collector.stop();

            const confirmFilter = m => isStaff(m.member, m.author) && m.content.toLowerCase().trim() === 'confirmed';
            const confirmCollector = channel.createMessageCollector({ filter: confirmFilter, time: 600000 });

            confirmCollector.on('collect', async () => {
                const updatedEmbed = EmbedBuilder.from(receiptEmbed).setColor(PASTEL_GREEN);
                await verifyMsg.edit({ embeds: [updatedEmbed] });
                await channel.send('_ _\npayment received. thank you!\n_ _');
                confirmCollector.stop();
            });

        } catch (err) {
            console.error('OCR Error:', err);
            await processingMsg.edit('⚠️ *Couldn\'t parse receipt automatically. Staff will verify manually.*');
        }
    });
}

client.login(process.env.DISCORD_TOKEN);
