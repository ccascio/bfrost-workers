# Webhook Inbox

Webhook Inbox accepts JSON posts and publishes them as `webhook.event` items on
the BFrost Item Bus.

## Endpoint

```bash
POST http://127.0.0.1:3030/api/workers/webhook-inbox/ingest
```

If you set a token in Config, pass it as either:

- `?token=YOUR_TOKEN`
- `x-bfrost-webhook-token: YOUR_TOKEN`

## Example

```bash
curl -X POST \
  'http://127.0.0.1:3030/api/workers/webhook-inbox/ingest?token=YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"title":"New order","source":"Shop","payload":{"id":"123"}}'
```

## What it produces

- `itemType`: `webhook.event`
- `producerWorkerId`: `webhook-inbox`
- Payload contains the original JSON under `payload`, plus source and received
  timestamp metadata.

## Configure

Open **Config** and edit **Webhook Inbox**.

- **Webhook token**: optional but recommended.
- **Source label**: fallback label when the incoming JSON has no `source`.
