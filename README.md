# Nhà Mình — Worker (private)

Cloudflare tự build & deploy từ repo này (Workers Builds) mỗi khi có commit vào `main`.

- `src/index.js` — toàn bộ API, phục vụ file R2 (link có chữ ký, hỗ trợ Range), webhook Telegram
  - `Hub` (Durable Object, WebSocket): báo tin mới tức thì, "đang soạn tin", "đang mở app". Rớt mạng thì app tự quay về đồng bộ định kỳ nên không mất tin.
  - Web Push: Worker tự sinh khóa VAPID (lưu trong D1 `meta`, **đừng xóa**) và tự mã hóa thông báo
- `wrangler.toml` — D1 `DB`, R2 `BUCKET` không ghi ID → Cloudflare tự tạo ở lần deploy đầu; Durable Object `HUB` được tạo bởi mục `[[migrations]]`
- Bảng dữ liệu: Worker tự tạo ở lần chạy đầu (`ensureDb`). `schema.sql` chỉ để tham khảo.

## Secret (Dashboard → Worker → Settings → Variables and Secrets)

| Tên | Bắt buộc | Ghi chú |
|---|---|---|
| `SETUP_KEY` | Có | Mã cài đặt lần đầu, dùng để đặt PIN cho Bố |
| `TG_BOT_TOKEN` | Không | Có thể nhập trong app: Cài đặt → Bot Telegram |
| `SECRET` | Không | Bỏ trống → Worker tự sinh. **Đừng thêm/đổi sau khi đã dùng** (mọi PIN sẽ phải đặt lại) |

## Test

```
node test/api.test.mjs        # toàn bộ API (D1/R2/Telegram giả lập)
node test/realtime.test.mjs   # Web Push (giải mã như trình duyệt, kiểm chữ ký VAPID) + Hub
npx wrangler dev --local --port 8788   # rồi: node test/ws.real.mjs   (WebSocket thật trên workerd; cần file .dev.vars có SETUP_KEY=nha-setup)
```
