'use strict';
/**
 * Pluggable, dependency-free mailer.
 *
 *   MAIL_WEBHOOK_URL    POST {to, subject, text} as JSON to this URL
 *   MAIL_WEBHOOK_TOKEN  sent as `Authorization: Bearer <token>` when set
 *
 * Without a webhook nothing leaves the process: the message is printed to the
 * console (unless `silent`) and kept in an in-memory `outbox`, which is what
 * the tests read. `enabled` therefore means "real delivery is configured" and
 * is reported as `emailEnabled` on /api/health.
 *
 * Links are built exclusively from PUBLIC_URL – never from the Host or Origin
 * header, which an attacker can forge to steal reset tokens.
 */

function normalizeBase(url) {
    return String(url || '').trim().replace(/\/+$/, '');
}

/** `${PUBLIC_URL}/#community?verify=TOKEN` */
function appLink(publicUrl, hashRoute) {
    return `${normalizeBase(publicUrl)}/#${hashRoute}`;
}

function verificationMail({ publicUrl, token, username, email }) {
    const link = appLink(publicUrl, `community?verify=${token}`);
    return {
        to: email,
        subject: 'Confirm your ReviseForFun email',
        text: [
            `Hi ${username},`,
            '',
            'Confirm this email address to use it for signing in and password resets:',
            '',
            link,
            '',
            'The link expires in 24 hours. If you did not ask for this, you can ignore the email.',
            '',
            '— ReviseForFun',
        ].join('\n'),
        link,
    };
}

function resetMail({ publicUrl, token, username, email }) {
    const link = appLink(publicUrl, `community?reset=${token}`);
    return {
        to: email,
        subject: 'Reset your ReviseForFun password',
        text: [
            `Hi ${username},`,
            '',
            'Someone asked to reset your ReviseForFun password. Choose a new one here:',
            '',
            link,
            '',
            'The link expires in one hour and can only be used once.',
            'If this was not you, ignore this email – your password stays the same.',
            '',
            '— ReviseForFun',
        ].join('\n'),
        link,
    };
}

function createMailer(options = {}) {
    const webhookUrl = options.webhookUrl !== undefined ? options.webhookUrl : (process.env.MAIL_WEBHOOK_URL || '');
    const webhookToken = options.webhookToken !== undefined ? options.webhookToken : (process.env.MAIL_WEBHOOK_TOKEN || '');
    const silent = Boolean(options.silent);
    const outbox = [];
    const enabled = Boolean(normalizeBase(webhookUrl));

    async function send(message) {
        const mail = {
            to: message.to,
            subject: message.subject,
            text: message.text,
            sentAt: Date.now(),
            delivered: false,
        };
        outbox.push(mail);
        while (outbox.length > 200) outbox.shift();
        if (!silent) {
            console.log(`\n📧  mail → ${mail.to}\n    ${mail.subject}\n${mail.text.split('\n').map((l) => `    ${l}`).join('\n')}\n`);
        }
        if (enabled) {
            try {
                const res = await fetch(webhookUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(webhookToken ? { Authorization: `Bearer ${webhookToken}` } : {}),
                    },
                    body: JSON.stringify({ to: mail.to, subject: mail.subject, text: mail.text }),
                });
                mail.delivered = res.ok;
                mail.status = res.status;
            } catch (err) {
                mail.error = err.message;
                if (!silent) console.error(`mail webhook failed: ${err.message}`);
            }
        }
        return mail;
    }

    return { enabled, silent, webhookUrl: normalizeBase(webhookUrl), outbox, send, last: () => outbox[outbox.length - 1] || null };
}

module.exports = { createMailer, verificationMail, resetMail, appLink, normalizeBase };
