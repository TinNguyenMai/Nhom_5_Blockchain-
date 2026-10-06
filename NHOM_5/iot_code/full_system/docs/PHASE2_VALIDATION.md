# Kiểm chứng Phase 2

Ngày: 27/09/2026. Môi trường đã chạy: Linux, Python 3.12, FastAPI 0.141.1, Uvicorn 0.54.0, Paho MQTT 2.1.0, SQLite của Python.

## Kết quả thực thi

| Nhóm | Kết quả |
|---|---|
| Unit/API/persistence của backend | 22 ca đạt |
| Tích hợp broker MQTT + simulator + HTTP + khởi động lại | 1 ca đạt |
| Kiểm tra tương thích model/config/panel Phase 1 | 19 ca + 14 subtest đạt |
| Kiểm tra dependency (`pip check`) | Không có dependency bị xung đột |

Ca tích hợp dùng **simulator của dự án**, broker AMQTT thật chạy TCP loopback, backend qua tiến trình Uvicorn và API HTTP thật. Backend mở trước broker: `/health` hoạt động, `/ready` trả 503; khi broker mở, backend tự kết nối và đăng ký MQTT.

Chạy 30 khoảng của ba nhà: nhận 90 telemetry, 19 prediction và 19 proposal. Mỗi prediction được phát hai lần; vẫn chỉ có 19 bản ghi. Có 18 proposal `observed`, 1 `stopped` ở cuối lượt; tất cả có `on_chain=false`. Tắt/mở backend giữ nguyên số bản ghi.

**Prediction trong ca tích hợp là bản tin giả lập có schema ESP32, tên model `wire-fixture-not-real-inference`, thời gian suy luận bằng 0.** Ca thử chứng minh tiếp nhận/lưu trữ/truy xuất, không chứng minh chạy AI trên board, cũng không thay thế kết quả board thật của người dùng ở Phase 1. Không có dữ liệu kiểm thử hoặc DB giả lập được đóng gói làm kết quả nghiệm thu.

Các ca khác kiểm tra: công thức kW→kWh, bán/mua/hold và lượng làm tròn xuống; trùng ID; xung đột nội dung giữ bản gốc; JSON sai/NaN/trùng khóa; retained; topic/schema/time/step sai; lọc thiết bị; dự báo tới trước số đo; dự báo trễ; thiếu mẫu; lịch sử run khác nhau; số đo đến đảo thứ tự; stale; simulator dừng; MQTT mất kết nối; phân trang API; không có endpoint ghi giao dịch; snapshot chính sách không đổi khi cấu hình mới.

## Chạy lại kiểm thử (tùy chọn)

Tại thư mục gốc dự án, cài thêm thư viện kiểm thử trong `.venv-backend`:

```powershell
.\.venv-backend\Scripts\python.exe -m pip install -r .\backend\requirements-test.txt
.\.venv-backend\Scripts\python.exe -m pytest .\backend\tests -q
```

Không cần ESP32 cho ca thử phần mềm. Broker kiểm thử dùng cổng ngẫu nhiên cục bộ, DB tạm; không ghi đè database demo. Có hai cảnh báo deprecation từ thư viện kiểm thử (Starlette/httpx và passlib/crypt) trên môi trường Linux đã chạy, không làm ca thử thất bại.

## Giới hạn kiểm chứng

- Chưa thực thi backend mới trên máy Windows hoặc ESP32 của người dùng. Các lệnh Windows được soạn theo môi trường dự án đã xác nhận, cần chạy lượt demo thật theo PHASE2.md.
- Đã kiểm tra API, phục vụ HTML và cú pháp JavaScript; chưa kiểm tra trực quan trang bằng trình duyệt vì Chromium không tải được trong môi trường này.
- Chưa đo benchmark tải lớn, độ bền khi mất điện, mất gói kéo dài hoặc phục hồi bản tin offline. Backend không tự nhập CSV cũ hoặc phát bù dữ liệu đã mất.
- Chưa có Smart Contract, matching, giá, token, thanh toán, chứng thực mật mã thiết bị hoặc frontend React/MetaMask.
- Không huấn luyện/chỉnh sửa/nạp lại mô hình hoặc firmware trong lượt triển khai Phase 2 này.

## Nghiệm thu trên Windows/board thật

Mở broker, ESP32 monitor, backend; đợi READY trước simulator. Chạy 30 bước để kiểm tra nhanh, sau đó 288 bước để lưu bằng chứng. Theo từng run, kỳ vọng 864 telemetry, 277 prediction/proposal nếu không mất bản tin; dừng/mở lại backend phải giữ dữ liệu. Chụp trang theo dõi, lưu JSON proposal và sao lưu SQLite sau khi backend dừng.
