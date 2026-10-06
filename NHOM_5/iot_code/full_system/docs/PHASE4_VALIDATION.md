# Phase 4 — Kết quả kiểm thử

Ngày kiểm thử: 27/09/2026. Nguồn kiểm thử là bản mã Phase 4 trong gói bàn giao.

## Kết quả

**PASS:** build React/Vite; 17 kiểm thử hợp đồng/bridge cũ; 9 kiểm thử đơn vị luồng ví; kiểm thử tích hợp trình duyệt với FastAPI/SQLite và Hardhat thật.

Môi trường: Linux, Node 24.19.0, React/React DOM 19.3.0, Ethers 6.17.0, Hardhat 3.18.0, solc 0.8.28, Vite 8.3.1, Playwright 1.63.0. Dùng Chromium 153.0.8010.0 trong môi trường kiểm thử. Do gói Chromium mặc định của Playwright không tải được trong môi trường này, browser binary lấy từ gói npm `@sparticuz/chromium` 153.0.0; chạy Playwright với `SOLAR_BROWSER_BIN` trỏ tới binary đó. Gói này không phải phụ thuộc của ứng dụng và không cần trên Windows.

## 17 kiểm thử hồi quy Phase 3

Chạy `npm test`: 17 passed, 0 failed. Bao gồm chuyển đổi đơn vị, nguồn dự báo, giá mua/bán, ưu tiên giá, khớp từng phần, hoàn tiền, hủy, giới hạn quyền, deadline, nguồn trùng, giới hạn lượng/giá, atomic escrow và cách ly tiền giữa các phiên.

Không thay Solidity trong Phase 4. Kích thước deployed bytecode vẫn: SolarToken 1.826 byte; EnergyMarket 6.835 byte. Python backend, firmware, MQTT và model giữ nội dung nguồn Phase 3.

## 9 kiểm thử đơn vị luồng ví

| Kiểm tra | Kết quả |
| --- | --- |
| Đơn vị nguyên; chặn số âm, exponent, dấu phẩy, 0, quá độ chính xác và quá giới hạn | PASS |
| Buy xóa hạn mức cũ nếu cần rồi approve đúng số tiền, không unlimited | PASS |
| Sell không xin quyền ERC20 | PASS |
| Từ chối approve không gửi lệnh | PASS |
| Đổi tài khoản giữa approve và order chặn bước order | PASS |
| Dự báo hết hiệu lực sau approve chặn lệnh Live | PASS |
| Nguồn/ví đã dùng bị chặn trước approve | PASS |
| Ví Nhà 2 không ký lệnh dự báo Nhà 1 qua luồng UI | PASS |
| Lỗi ví / TooEarly có giải thích | PASS |

## Gateway và trình duyệt

`npm run test:phase4` khởi tạo SQLite, node Hardhat và các cổng HTTP riêng. Backend chạy mã FastAPI/SQLite thật; dự báo và số đo là fixture test. Ví trình duyệt là EIP-1193 adapter gọi tài khoản thử nghiệm unlocked trên node, không phải extension MetaMask.

Các bước đã đạt:

1. Proxy đọc backend, xác minh triển khai chain đang hoạt động.
2. Chặn POST sai Origin, sai session token; chặn GET từ Origin ngoài; không cung cấp generic RPC proxy.
3. Chặn chuẩn bị Live từ lượt đã stopped; chặn deployment ID không khớp.
4. Trình duyệt kết nối ví qua EIP-6963, chọn đề xuất, chuẩn bị bằng chứng, mở phiên bằng Điều phối.
5. Từ chối giao dịch trong ví: sổ lệnh vẫn 0; gửi lại thành công.
6. Nhà 1 gửi lệnh bán từ forecast; Nhà 2 approve và gửi lệnh mua qua giao diện.
7. Test tăng thời gian node tới deadline (chỉ trong test), người dùng test bấm Kết toán.
8. Receipt status 1, sự kiện `TradeExecuted`, report có `source_hash_verified: true`.
9. Tải JSON từ nút Xuất báo cáo; lưu cùng cấu trúc Phase 3.
10. Một phiên khác: Nhà 1 đặt lệnh mua, khóa SLC, hủy và nhận lại tiền; nút gửi thêm lệnh bị vô hiệu hóa.
11. Đổi sang mạng sai rồi chuyển về local; xem receipt đã giải mã trong modal.
12. Viewport 390 × 844 không tràn ngang trang; không có lỗi JavaScript runtime trong lượt test.
13. CLI `market:report` đọc được giao dịch do trình duyệt tạo; API Phase 2 gắn `on_chain: true` cho đề xuất đã kết toán.
14. Khi mã hợp đồng trên node bị thay đổi trong fixture, gateway từ chối coi triển khai cũ là hợp lệ.

### Bằng chứng của lượt test tự động

Phiên 1:

```text
mode=replay
settled=true
orders=2
trades=1
source_hash_ok=true
quantity=100 Wh
ask=2 SLC/kWh
bid=3 SLC/kWh
cost=0.2 SLC
settlement receipt status=1
```

Số dư sau khớp: Nhà 1 = 1000,2 SLC; Nhà 2 = 999,8 SLC; Nhà 3 = 1000 SLC. Tổng 3000 SLC, escrow 0. Phiên 2 có một lệnh mua đã hủy, locked = 0; cố ý để phiên đó chưa kết toán nhằm kiểm tra trạng thái pending. Vì vậy CLI cuối test báo `rounds=2 trades=1 pending=1`, escrow 0; đây không phải lỗi.

Receipt của fixture cuối: `0x3f29571dc417446e15a439eadaa7ce6b0a8933e63e67123a54fb7955153a5c21`, khối 11. Node fixture đã được đóng sau test; mã này chỉ ghi nhận lượt kiểm thử, không tra cứu trên Etherscan hoặc node của bạn.

Ảnh chụp thực tế từ browser test ở `docs/phase4-overview.png`, `docs/phase4-market-settled.png`, `docs/phase4-receipt.png`, `docs/phase4-mobile.png`. Dữ liệu trong các ảnh là fixture, không phải dữ liệu board vật lý của người dùng.

## Giới hạn xác nhận

- Chưa điều khiển extension MetaMask thật hoặc máy Windows của người dùng trong lượt kiểm thử này. Người dùng cần thực hiện mục nghiệm thu trong PHASE4.md.
- Chưa kiểm thử board ESP32/MQTT vật lý trong Phase 4; giữ luồng Phase 1–3 đã được người dùng chạy thành công.
- Happy path trình duyệt dùng Replay. Live được kiểm tra các điều kiện chặn stale/đổi ngữ cảnh; chưa nghiệm thu thao tác nhiều ví thủ công với simulator Live tại máy người dùng.
- Giao diện và gateway chỉ hỗ trợ Hardhat local, chain 31337. Chưa có public-testnet deployment hoặc Etherscan verification.
- Hash nguồn chứng minh dữ liệu đối chiếu trùng, không xác thực cảm biến/AI hay điện thực đã giao.
- Chưa có đăng nhập nhiều người dùng, lưu blockchain qua restart, oracle công tơ hoặc thanh toán tài sản thật.

Các giới hạn trên không được che bằng dữ liệu giả trong ứng dụng. Ngoại tuyến, thiếu dữ liệu, nguồn đã dùng, triển khai không khớp và giao dịch lỗi đều hiển thị trạng thái riêng.
