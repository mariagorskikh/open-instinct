# @open-instinct/whatsapp

The agent's own WhatsApp account as a channel. It joins the account as a linked device
through [Baileys](https://github.com/WhiskeySockets/Baileys), WhatsApp Web's multi-device
protocol over a WebSocket. There is no browser, and it runs comfortably on a Raspberry Pi.

## Set up

1. Give the agent a number of its own (a spare SIM or eSIM) and register it in the
   **WhatsApp Business** app. On Android it runs alongside your personal WhatsApp.
2. Add `WHATSAPP_PHONE=+44...` (that number) to the agent's environment and restart.
3. The log prints `whatsapp: pairing code ABCD-EFGH`. In WhatsApp Business: Settings,
   Linked devices, Link a device, Link with phone number instead, and enter the code.
4. Message the agent's number from your own WhatsApp.

Credentials live in `<data>/secrets/whatsapp`. To unlink, delete that folder and restart.

## What it does

- One-to-one chats only. Groups, broadcasts, status and channels are ignored.
- The sender's number is the identity: the owner's number is the owner, contacts get their
  tier, anyone else is a stranger. WhatsApp verifies numbers, so the owner's messages count
  as the owner, as on iMessage and SMS.
- Photos, voice notes and documents are saved to `workspace/inbound` for `open_attachment`.
- Replies are text, with a typing indicator and read receipts. Owner notices follow the
  owner to WhatsApp once they last wrote from it.
- Messages are persisted (`whatsapp-inbox.json`) before they are handled.

## Caveats

- Baileys is unofficial and WhatsApp's terms do not allow it. Keep the account for the agent
  alone and never bulk-message from it, or the number can be banned.
- The phone holding the account must open WhatsApp at least every 14 days, or WhatsApp logs
  linked devices out. The log then says so; pair again.
