# Kết quả kiểm tra bộ mã Phase 1

## Bản cập nhật Phase 1B

Đã chạy 15 kiểm thử thành công trên Linux/Python 3.12.14 với Paho 2.1.0 và
aMQTT 0.11.3 (chỉ phục vụ integration test):

- Giữ các kiểm tra Phase 1A về ngày/đêm, kW/kWh, timestamp và schema.
- Cấu hình JSON hợp lệ; từ chối ID trùng, kiểu sai, số âm/NaN và cấu hình ngoài giới hạn.
- Nhà thứ tư được sinh dữ liệu và được subscriber chấp nhận từ cùng file config.
- Nắng/mây ảnh hưởng công suất; sunny ban đêm vẫn phát 0; tắt PV cho ra 0;
  hệ số tải 2 tạo tải xấp xỉ gấp đôi.
- Điều khiển MQTT pause/resume, đổi tốc độ/thời tiết, đổi PV/tải, stop đã được thử
  trên broker. Khi đã xác nhận paused, không sinh đợt đo mới.
- Lệnh sai bị từ chối; cập nhật nhà được kiểm tra trọn vẹn trước khi áp dụng;
  request_id trùng không bị áp dụng lần hai trong bộ nhớ đệm.
- Dataset từ chối lệnh điều khiển và phát đủ 12 khoảng × 4 nhà = 48 bản tin;
  subscriber ghi đủ 48 dòng mới, không trùng ID.
- Cấu hình và nhật ký điều khiển theo run_id được tạo.
- Mailbox của panel giữ số đo gần nhất và có giới hạn bộ nhớ.
- Tất cả module biên dịch cú pháp thành công, `panel --help` chạy được.

Chưa kiểm tra trực quan cửa sổ Tkinter trên Windows: môi trường kiểm thử không có
display server. Phần giao tiếp MQTT và xử lý điều khiển đã được thử; bố cục cửa sổ,
font và Tcl/Tk trên máy Windows cần được xác nhận khi người dùng mở panel.
Chưa thử broker Mosquitto trực tiếp trong môi trường này; Mosquitto ở Phase 1A
đã được người dùng xác nhận chạy thành công trên máy của họ.

## Kiểm tra Phase 1A ban đầu

Đã kiểm tra ngày 21/09/2026 trong môi trường Linux, Python 3.12.14,
Eclipse Paho MQTT 2.1.0. Kiểm tra luồng mạng sử dụng broker MQTT aMQTT 0.11.3
chạy tại 127.0.0.1:1884. aMQTT chỉ dùng trong môi trường kiểm tra, không phải
phụ thuộc của dự án; hướng dẫn người dùng sử dụng Eclipse Mosquitto.

- 4 kiểm tra tự động trong `tests/test_model.py` đều đạt.
- Chạy 288 khoảng đo, mỗi khoảng 5 phút, cho 3 hộ: nhận và ghi đủ 864 bản tin.
- Đủ 3 mã hộ, không trùng event ID trong lượt chạy.
- Công suất phát ban đêm và công suất phát của hộ 3 bằng 0.
- Cân bằng năng lượng và phép đổi kW sang kWh đạt kiểm tra.
- Gửi lại bản tin có cùng event ID: không tăng số dòng CSV.
- JSON sai cú pháp và công suất âm: bị từ chối.
- Dừng/mở lại subscriber trên cùng CSV: bản tin cũ vẫn bị bỏ trùng,
  bản tin có ID mới vẫn được thêm.

Ví dụ log thu được khi đồng hồ mô phỏng đến 12:00:

```text
RECV #433 2026-09-01T12:00:00+07:00 home_01 solar=1.954kW load=0.637kW net=+1.317kW
RECV #434 2026-09-01T12:00:00+07:00 home_02 solar=1.221kW load=1.038kW net=+0.184kW
RECV #435 2026-09-01T12:00:00+07:00 home_03 solar=0.000kW load=1.005kW net=-1.005kW
DONE: 288 khoang do, 864 ban tin.
```

Chưa trực tiếp chạy bộ cài Windows hoặc broker Mosquitto trong môi trường này.
Cấu hình Mosquitto và cú pháp Paho đã được đối chiếu tài liệu chính thức liên kết
trong README. Đây là kiểm tra kỹ thuật Phase 1, chưa phải kết quả của hệ thống
đầy đủ IoT → AI → Smart Contract và chưa xác thực độ chính xác ngoài thực tế.
