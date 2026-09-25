const { requireAdmin } = require("../middleware/requireAuth");
// =========================
// LIVE CHAT API
// =========================
// A genuinely real two-way channel: a customer's message lands here,
// the admin sees and replies from admin-chat.html, and the customer
// sees that reply the next time their widget polls for updates.
//
// A conversation's id acts like a bearer token for the customer side
// — knowing it is what lets you read/send messages in it, the same
// trust model as a booking reference. It's a real UUID, not
// guessable, and stored in the customer's own browser (localStorage)
// so their conversation continues across page loads.

const express = require("express");
const router = express.Router();
const pool = require("../db");
const { sendNewChatAlertEmail, sendChatReplyEmail } = require("../email");

function conversationShape(row) {
    return {
        id: row.id,
        customerName: row.customer_name,
        customerEmail: row.customer_email,
        status: row.status,
        unreadByAdmin: row.unread_by_admin,
        createdAt: row.created_at,
        lastMessageAt: row.last_message_at
    };
}

function messageShape(row) {
    return {
        id: row.id,
        sender: row.sender,
        message: row.message,
        createdAt: row.created_at
    };
}

// =========================
// CUSTOMER-FACING (public)
// =========================

// POST /api/chat/conversations — start a new conversation
router.post("/conversations", async (req, res) => {
    try {
        const { customerName, customerEmail, message } = req.body;

        if (!customerName || !message) {
            return res.status(400).json({ error: "customerName and message are required." });
        }

        const convResult = await pool.query(
            `INSERT INTO chat_conversations (customer_name, customer_email)
             VALUES ($1, $2)
             RETURNING *`,
            [customerName, customerEmail || null]
        );

        const conversation = convResult.rows[0];

        await pool.query(
            "INSERT INTO chat_messages (conversation_id, sender, message) VALUES ($1, 'customer', $2)",
            [conversation.id, message]
        );

        // An immediate, automatic first reply — not a real answer,
        // just an honest acknowledgment so the customer isn't left
        // staring at silence while waiting for a real person.
        await pool.query(
            "INSERT INTO chat_messages (conversation_id, sender, message) VALUES ($1, 'admin', $2)",
            [conversation.id, `Hi ${customerName}, thanks for reaching out! We'll get right back to you on your enquiry.`]
        );

        // A real, immediate heads-up to the admin's own inbox — the
        // closest a solo operator can get to "24/7," short of
        // literally staffing it around the clock. Links straight to
        // THIS conversation, already open, so replying is one click
        // rather than hunting for it in the inbox list first.
        sendNewChatAlertEmail(process.env.ADMIN_ALERT_EMAIL || "fsstransportltd@gmail.com", {
            customerName,
            message,
            conversationId: conversation.id
        }).catch(() => {}); // never let an alert failure block the actual conversation from starting

        res.status(201).json({ conversationId: conversation.id });
    } catch (err) {
        console.error("POST /api/chat/conversations failed:", err);
        res.status(500).json({ error: "Couldn't start a chat right now." });
    }
});

// GET /api/chat/conversations/:id/messages — poll for the full message history
router.get("/conversations/:id/messages", async (req, res) => {
    try {
        const convCheck = await pool.query("SELECT id, status FROM chat_conversations WHERE id = $1", [req.params.id]);
        if (convCheck.rows.length === 0) {
            return res.status(404).json({ error: "Conversation not found." });
        }

        const messagesResult = await pool.query(
            "SELECT * FROM chat_messages WHERE conversation_id = $1 ORDER BY created_at ASC",
            [req.params.id]
        );

        res.json({
            status: convCheck.rows[0].status,
            messages: messagesResult.rows.map(messageShape)
        });
    } catch (err) {
        console.error("GET /api/chat/conversations/:id/messages failed:", err);
        res.status(500).json({ error: "Couldn't load messages." });
    }
});

// POST /api/chat/conversations/:id/messages — customer sends a message
router.post("/conversations/:id/messages", async (req, res) => {
    try {
        const { message } = req.body;

        if (!message || !message.trim()) {
            return res.status(400).json({ error: "message is required." });
        }

        const convCheck = await pool.query("SELECT id, status FROM chat_conversations WHERE id = $1", [req.params.id]);
        if (convCheck.rows.length === 0) {
            return res.status(404).json({ error: "Conversation not found." });
        }

        if (convCheck.rows[0].status === "closed") {
            return res.status(400).json({ error: "This conversation has been closed." });
        }

        await pool.query(
            "INSERT INTO chat_messages (conversation_id, sender, message) VALUES ($1, 'customer', $2)",
            [req.params.id, message.trim()]
        );

        // A reply on an existing conversation flags it as unread
        // again, so the admin inbox correctly shows it needs a look.
        await pool.query(
            "UPDATE chat_conversations SET last_message_at = now(), unread_by_admin = true WHERE id = $1",
            [req.params.id]
        );

        res.status(201).json({ sent: true });
    } catch (err) {
        console.error("POST /api/chat/conversations/:id/messages failed:", err);
        res.status(500).json({ error: "Couldn't send that message." });
    }
});

// =========================
// ADMIN-FACING
// =========================

// GET /api/chat/conversations — admin inbox list
router.get("/conversations", requireAdmin, async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT * FROM chat_conversations ORDER BY last_message_at DESC"
        );
        res.json(result.rows.map(conversationShape));
    } catch (err) {
        console.error("GET /api/chat/conversations failed:", err);
        res.status(500).json({ error: "Couldn't load conversations." });
    }
});

// GET /api/chat/conversations/:id — admin view of one full conversation
router.get("/conversations/:id", requireAdmin, async (req, res) => {
    try {
        const convResult = await pool.query("SELECT * FROM chat_conversations WHERE id = $1", [req.params.id]);
        if (convResult.rows.length === 0) {
            return res.status(404).json({ error: "Conversation not found." });
        }

        const messagesResult = await pool.query(
            "SELECT * FROM chat_messages WHERE conversation_id = $1 ORDER BY created_at ASC",
            [req.params.id]
        );

        // Opening it in the admin inbox is what actually clears the
        // "unread" flag — genuinely being looked at, not just listed.
        await pool.query("UPDATE chat_conversations SET unread_by_admin = false WHERE id = $1", [req.params.id]);
        convResult.rows[0].unread_by_admin = false; // reflect that same change in what we're about to return, not the stale pre-update value

        res.json({
            conversation: conversationShape(convResult.rows[0]),
            messages: messagesResult.rows.map(messageShape)
        });
    } catch (err) {
        console.error("GET /api/chat/conversations/:id failed:", err);
        res.status(500).json({ error: "Couldn't load that conversation." });
    }
});

// POST /api/chat/conversations/:id/reply — admin sends a reply
router.post("/conversations/:id/reply", requireAdmin, async (req, res) => {
    try {
        const { message } = req.body;

        if (!message || !message.trim()) {
            return res.status(400).json({ error: "message is required." });
        }

        const convCheck = await pool.query("SELECT id, customer_name, customer_email FROM chat_conversations WHERE id = $1", [req.params.id]);
        if (convCheck.rows.length === 0) {
            return res.status(404).json({ error: "Conversation not found." });
        }

        await pool.query(
            "INSERT INTO chat_messages (conversation_id, sender, message) VALUES ($1, 'admin', $2)",
            [req.params.id, message.trim()]
        );

        await pool.query("UPDATE chat_conversations SET last_message_at = now() WHERE id = $1", [req.params.id]);

        // Not everyone has the widget open when a reply comes in —
        // an email means they actually see it, not just the site.
        // Only possible for customers who left an address in the
        // first place; the widget makes this optional.
        const conv = convCheck.rows[0];
        if (conv.customer_email) {
            sendChatReplyEmail(conv.customer_email, {
                customerName: conv.customer_name,
                message: message.trim()
            }).catch(() => {}); // never let an email failure block the actual reply from sending
        }

        res.status(201).json({ sent: true });
    } catch (err) {
        console.error("POST /api/chat/conversations/:id/reply failed:", err);
        res.status(500).json({ error: "Couldn't send that reply." });
    }
});

// PUT /api/chat/conversations/:id/close — admin marks it resolved
router.put("/conversations/:id/close", requireAdmin, async (req, res) => {
    try {
        const result = await pool.query(
            "UPDATE chat_conversations SET status = 'closed' WHERE id = $1 RETURNING id",
            [req.params.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Conversation not found." });
        }

        res.json({ closed: true });
    } catch (err) {
        console.error("PUT /api/chat/conversations/:id/close failed:", err);
        res.status(500).json({ error: "Couldn't close that conversation." });
    }
});

module.exports = router;
