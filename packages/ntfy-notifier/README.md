# ntfy Notifier

ntfy Notifier sends selected BFrost Item Bus entries to an ntfy topic.

## What it consumes

By default it watches:

- `news.article`
- `research.paper`
- `web.page`
- `webhook.event`

You can change this in **Jobs**.

## Configure

Open **Jobs** and edit **Send ntfy notifications**.

- **ntfy server URL**: defaults to `https://ntfy.sh`.
- **Topic**: required. Use a hard-to-guess topic and subscribe to it in the ntfy app.
- **Item types**: one Item Bus type per line.
- **Max notifications per run**: caps notification volume.
- **Priority**, **tags**, and **include source URL** control the ntfy message.

## Safety

The worker writes only to `metadata["ntfy-notifier"]` on each handled item. It does
not mark items as posted or change global item state, so it can run alongside
publishers and archives.
