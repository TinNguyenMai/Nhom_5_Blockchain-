# Cập nhật điều khiển PV

## Cài đặt bản cập nhật

Đóng cửa sổ panel cũ. Chép `iot_code/panel.py` từ gói này đè lên đúng file
`iot_code/panel.py` trong dự án của bạn. Chỉ cần thay file này để dùng giao diện mới.
Giữ nguyên `data`, `.venv` và `config/homes.json`. Không cần reset dữ liệu.
Các file test và tài liệu có thể chép thêm để kiểm thử, không cần để chạy panel.

Mở lại panel tại thư mục gốc dự án:

```powershell
.\.venv\Scripts\python.exe -m iot_code.panel
```

Simulator và subscriber đang chạy có thể giữ nguyên: giao thức MQTT không đổi.

## Thao tác mới

1. Chọn nhà.
2. Chọn `Bật` hoặc `Tắt` trong `PV muốn đặt`.
3. Nhấn `Đổi trạng thái PV`, chờ simulator xác nhận.
4. Xem dòng `PV BẬT/TẮT (simulator)` để biết trạng thái đã áp dụng.
5. Nếu đang tạm dừng, nhấn `Tiếp tục` để thấy số đo mới.

Chọn trong danh sách chưa gửi lệnh. Nút `Đổi tải` chỉ thay đổi hệ số tải,
không bật/tắt PV. Nút PV chỉ thay đổi PV, không thay đổi tải.
Trạng thái nhập chưa gửi được giữ khi bảng cập nhật cùng một nhà.
Lựa chọn được nạp lại khi chuyển sang nhà khác hoặc nhận lượt chạy mới.

## PV bật nhưng 0 kW

Ảnh chụp lúc 23:20 có bức xạ 0 W/m². Đó là ban đêm: bật PV vẫn phát 0 kW.
Chọn `sunny` chỉ giảm mây, không làm mặt trời xuất hiện ban đêm.
Nhà có công suất lắp đặt 0 kW cũng không phát điện dù chọn Bật.
Panel mới hiển thị giải thích các trường hợp này. Số đo giữ nguyên khi paused.

Để thử ban ngày, dừng simulator cũ trước rồi chạy một lượt demo mới:

```powershell
.\.venv\Scripts\python.exe -m iot_code.simulator --paused --start "2026-09-01T12:00:00+07:00" --step-seconds 300 --interval 5
```

Chọn Nhà 1, sunny; nhấn Tiếp tục. Thử Tắt → Đổi trạng thái PV → đợi đợt mới:
phát 0 kW. Thử Bật → Đổi trạng thái PV → đợi đợt mới: phát > 0 kW.
Không dùng file dataset chính thức cho lượt thử này; subscriber mặc định ghi nối.

## Kiểm thử

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

Kiểm thử thêm: nhiều chu kỳ tắt/bật ban ngày, bật ban đêm, phát lại buổi sáng,
PV và tải độc lập, thông báo paused/không lắp PV/trạng thái cũ,
và bật lại qua MQTT với xác nhận trạng thái cùng số đo lưu CSV.
Integration test cần amqtt và sẽ bỏ qua nếu chưa cài trong môi trường kiểm thử.
Giao diện Tkinter cần kiểm tra trực quan trên Windows sau khi cập nhật.
