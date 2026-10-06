# Kiểm tra gói mã cho thành viên nhóm

Ngày kiểm tra: 03/10/2026 trên Windows. Gói được cài dependency riêng trong `submission/p2p-solar-team`; không dựa vào node_modules được sao chép từ máy tác giả.

## Phạm vi thay đổi

- Firmware chính ESP-IDF hỗ trợ INA219 0x40/0x41, LCD 0x27, relay GPIO4/25, DS18B20 GPIO27 và mô hình INT8 có sẵn.
- DS18B20 dùng driver Espressif 0.2.0, 1-Wire 1.1.2; conversion chạy task riêng. Mẫu cũ quá 5 giây, lỗi cảm biến và giá trị ngoài phạm vi được loại.
- Telemetry điện 5 phút giữ hoạt động khi thiếu nhiệt độ. Nhiệt độ có nguồn/cờ hợp lệ/số mẫu snapshot và được backend giữ lại. LCD có thêm trang nhiệt độ.
- Model 53 đầu vào và trọng số giữ nguyên; nhiệt độ chưa tham gia suy luận.
- Giới hạn chờ khởi động Hardhat được tăng lên 120 giây để hỗ trợ cold start trên máy Windows mới cài; lỗi tạo tiến trình được báo rõ.
- Cấu hình Wi-Fi/MQTT chuyển thành mẫu; script tạo cấu hình cá nhân trên máy thành viên. Bản Arduino đầy đủ cảm biến được giữ để tham chiếu, không có INT8.

## Kết quả đã kiểm tra

| Hạng mục | Kết quả |
|---|---|
| `npm ci` trong gói riêng | Thành công, cài theo package-lock |
| Build dashboard trong gói | Thành công; còn cảnh báo chunk ứng dụng cũ >500 kB |
| Kiểm tra C++ host tổng hợp số đo/nhiệt độ và relay | 8/8 đạt, chạy từ gói |
| Kiểm tra backend | 24/24 đạt, chạy từ gói; có cảnh báo deprecation FastAPI/Starlette TestClient |
| Script cấu hình firmware | Parse PowerShell và tạo file từ mẫu đạt; kiểm tra bằng mật khẩu thử, sau đó phục hồi placeholder |
| UI demo 12 hộ | Đạt: luồng cơ bản, receipt, lọc hộ, JSON, mobile và các kiểm tra HTTP; không có lỗi JS |
| Full-demo 12 hộ từ gói | 22/22 đạt; escrow cuối = 0, kiểm tra bảo toàn token đạt |
| Firmware ở thư mục làm việc | Build ESP32/ESP-IDF 5.5.3 thành công; chưa nạp board trong lần kiểm tra này |
| Firmware từ chính gói bàn giao | Build `esp32dev_ai` thành công với cấu hình placeholder, ESP-IDF 5.5.3, TFLite Micro 1.4.1 và DS18B20 0.2.0 |
| Tương thích bản tin firmware cũ | 2 kiểm tra liên quan nhiệt độ chạy lại đạt; chấp nhận nhãn unavailable cũ chưa có cờ validity |

Các file log nội bộ được giữ ngoài gói tại thư mục build của project; cấu hình mạng cá nhân và cache không được bàn giao. `docs/TEAM_SIMULATION_REPORT.json` là báo cáo tham khảo của phiên chạy local đã kết thúc, không phải deployment hoạt động trên máy người nhận. Build firmware ghi nhận RAM tĩnh 72.988 byte và chương trình khoảng 1.021.503 byte; đây không phải benchmark RAM động hoặc thời gian suy luận trên board. Partition ứng dụng là 1500 KiB trong cấu hình ESP-IDF.

## Giới hạn của bằng chứng

Các kiểm tra C++ chạy với dữ liệu/stub trên PC, không xác minh bus 1-Wire/I2C, nhiệt độ, công suất, relay hay timing trên board thực. Không tự động flash thiết bị. Nhánh MQTT 12 hộ dùng công tơ/dự báo mô phỏng; không phải 12 ESP32 và không dùng INT8 cho từng hộ. Nhánh ESP32 demo chỉ đưa prediction có nguồn telemetry mô phỏng vào giao dịch/relay. Nhánh cảm biến thật gửi dữ liệu và AI nhưng không tự giao dịch bằng số đo thật.

Hai demo chạy riêng, chưa có chế độ hybrid 11+1. Token và Hardhat là thử nghiệm local. ZIP được kiểm tra CRC, đối chiếu SHA-256 theo manifest và rà soát loại cấu hình mạng cá nhân.
