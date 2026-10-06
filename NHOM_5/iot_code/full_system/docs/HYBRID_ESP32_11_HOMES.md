# 1 ESP32 + 11 hộ mô phỏng

Trên `/simulation`, chọn **1 ESP32 + 11 hộ mô phỏng**. Tổng cộng đúng 12 hộ. Mỗi lần chạy tạo một blockchain Hardhat, broker MQTT nội bộ và ví thử nghiệm riêng, xử lý một phiên 5 phút.

## Mặc định: Edge AI từ INA219 thật · 5 giây/mẫu

Nạp project `iot_code/firmware/esp32_edge` / environment `esp32dev_ai`. Khi khởi động, firmware ở chế độ đo thật nhanh (`demo_enabled=false`, `fast_real=true`): đọc hai INA219 mỗi 500 ms, lấy trung bình mỗi **5 giây thực** thành một mẫu, gửi `solar/home_01/telemetry`, rồi chạy model TFLite Micro INT8 trên board. Sau 12 mẫu (khoảng **60 giây**) có dự báo đầu tiên trên `solar/home_01/prediction`; sau đó có dự báo mới mỗi 5 giây.

Trên dashboard chọn **Edge AI từ INA219 thật · 5 giây/mẫu** (mặc định, `--esp-source ai-live`). Telemetry và prediction ghi `data_mode=real`, `time_mode=accelerated`, `sampling_seconds=5`. Cầu nối yêu cầu đúng ba giá trị này, đủ 12 mẫu, đúng model, bản tin đến trong 20 giây gần nhất; chờ tối đa 2 phút. Báo cáo dùng `data_kind=hybrid_accelerated_measurement`, `source_policy=edge-ai-live5s-v1`.

Mỗi mẫu 5 giây được model coi là một bước 5 phút, vì model huấn luyện với bước 5 phút. Do đó:

- `timestamp` là **thời gian logic**: bắt đầu từ mốc 5 phút hiện tại rồi tăng 5 phút mỗi mẫu; `published_at` và thời điểm backend nhận là giờ thật.
- Điện năng trong bản tin và lượng Wh của lệnh là công suất đo được quy đổi cho một bước 5 phút, không phải điện đo trong 5 giây.
- Dự báo chứng minh luồng cảm biến → AI trên board → MQTT → smart contract. Nó không phải bằng chứng về độ chính xác: model huấn luyện trên dữ liệu tổng hợp PV 4 kW, còn số đo của mạch thí nghiệm cỡ W nằm dưới bước lượng tử đầu vào.
- Trong mỗi cửa sổ 5 giây có khoảng 10 lần đọc. Lần đọc lỗi (cảm biến lỗi, dòng ngược vượt vùng 0 ±0,5 mA) bị loại khỏi trung bình; cửa sổ có dưới 5 lần đọc hợp lệ bị bỏ và lịch sử AI làm lại từ đầu. Thiếu một trong hai INA219 thì không có telemetry. `measurement_samples` ghi số lần đọc hợp lệ.
- Nếu board chưa đồng bộ giờ SNTP lúc bắt đầu, thời gian logic chạy từ mốc cố định `2026-10-02T06:00:00+07:00`.

Lệnh qua `solar/home_01/control`: `real fast` (mặc định, 5 giây/mẫu), `real slow` (trung bình 5 phút, xem mục dưới), `demo on` (mẫu mô phỏng), `demo off` (về đo thật). Trạng thái không được lưu qua lần reset.

## Lựa chọn: Edge AI mô phỏng nhanh · 5 giây/mẫu

Gửi `demo on` cho board. Firmware phát một mẫu mô phỏng mỗi **5 giây thực**. Model vẫn chạy trên ESP32 bằng TFLite Micro INT8. Sau 12 mẫu (khoảng **55–60 giây**) có dự báo đầu tiên; sau đó có dự báo mới mỗi 5 giây. Chế độ này không lấy đầu vào AI từ INA219.

Trên dashboard chọn **Edge AI mô phỏng nhanh · 5 giây/mẫu**. Mỗi mẫu tương ứng một bước 5 phút của model; timestamp là thời gian mô phỏng, không phải đồng hồ thực. Telemetry/prediction ghi `data_mode=simulation`, `time_mode=accelerated`, `sampling_seconds=5`. Cầu nối dùng thời điểm nhận để kiểm tra dữ liệu mới (tối đa 20 giây), chờ tối đa 2 phút. Không trộn nguồn này với chế độ đo thật.

Báo cáo dùng `data_kind=hybrid_accelerated_simulation`, `source_policy=edge-ai-accelerated5s-v1`; lệnh vẫn có `basis=esp32_forecast` vì suy luận chạy trên ESP32. Năng lượng giao dịch là năng lượng mô phỏng của khoảng 5 phút; không coi đó là điện đã đo trong 5 giây thực. 11 hộ và công tơ giao điện cũng là mô phỏng.

## Lựa chọn: Edge AI từ INA219 thật · 5 phút/mẫu

Gửi `real slow` cho board để dùng đúng nhịp 5 phút của model. Nạp project **`iot_code/firmware/esp32_edge`**, environment **`esp32dev_ai`** bằng PlatformIO. Entry point `main/main.cc` tự đọc INA219, DS18B20 và LCD bằng ESP-IDF, không include `blockchainV2.ino`. Model INT8 nằm trong `main/model_data.h`. Dùng `demo off` trong Serial Monitor 115200 để đọc thật; Wi-Fi được đồng bộ từ cấu hình Arduino cho mạng hiện tại, MQTT là `192.168.2.5:1885`. Nếu máy đổi IP, cập nhật URI trong `sdkconfig.esp32dev_ai`, `sdkconfig` và listener broker trước build.

Cảm biến thật → telemetry 5 phút → đủ 12 mẫu liên tiếp → AI dự báo 5 phút tiếp theo → backend → hybrid. Trên dashboard chọn nguồn **Edge AI từ INA219 thật**. Cầu nối yêu cầu `data_mode=real`, `history_samples=12`, đúng model version trong `ai_model/artifacts/metadata.json`, cùng run/event/timestamp với số đo mới nhất. Không tự chuyển sang số đo gần nhất nếu AI chưa sẵn sàng.

Dự báo đầu tiên cần khoảng 60–65 phút. Phiên AI chờ tối đa 65 phút mặc định; đổi chế độ, mất mẫu hoặc mất kết nối sẽ làm lại lịch sử. Firmware mới gửi nguồn dữ liệu và số mẫu kèm dự báo; firmware AI cũ cần nạp lại để hybrid chấp nhận.

## Lựa chọn Arduino · số đo gần nhất

PlatformIO `iot_code/firmware/blockchain_v2/src/main.cpp` include `blockchainV2.ino`. Firmware đọc hai INA219 (phát 0x40, tải 0x41), gửi trung bình công suất và điện năng mỗi 300 giây qua `solar/home_01/telemetry`. Firmware này chưa chạy AI; firmware Edge AI là bản riêng.

Trong Serial Monitor 115200, dùng `demo status` và `demo off` để xác nhận đo thật. Chế độ demo được lưu trong Preferences; sửa mặc định trong code không xóa lựa chọn đã lưu trên board. Nếu không tìm thấy cảm biến, firmware có thể bật demo. Hybrid chỉ chấp nhận `data_mode=real`, `demo_scenario=none`; không nhận dữ liệu demo hoặc phát lại lịch sử đã cũ.

Sketch hiện trỏ broker `192.168.2.5:1885`, cùng IP Wi-Fi của máy tại lúc kiểm tra. Khi đổi mạng/IP phải cập nhật địa chỉ broker trong sketch và listener trong `.local/mosquitto-edge.conf`. Broker LAN giữ xác thực và ACL hiện có; không thay mật khẩu. Thay code chưa nạp lên ESP32. Nạp bằng cấu hình PlatformIO hiện có khi board được kết nối.

## Chạy các dịch vụ

Từ thư mục dự án, mở các terminal riêng:

```powershell
& 'C:/Program Files/mosquitto/mosquitto.exe' -c .local/mosquitto-edge.conf
.venv-runtime/Scripts/python.exe -m backend --mqtt-host 127.0.0.1 --mqtt-port 1884 --port 8000 --stale-seconds 360
npm.cmd run dashboard:build
npm.cmd run simulation:hybrid -- --python .venv-runtime/Scripts/python.exe
```

Nếu dịch vụ đã chạy thì dùng lại. Mở `http://127.0.0.1:5260/simulation`; ô kết nối hiển thị backend/MQTT chưa sẵn sàng, chế độ không đúng, số đo cũ hoặc số đo thật đã nhận. Nhấn chạy; AI mô phỏng 5s chờ tối đa 2 phút; AI đo thật chờ tối đa 65 phút, chế độ Arduino chờ tối đa 6 phút để nhận nguồn còn mới. Có thể chỉnh `--hardware-timeout 360` (giây), `--esp-backend http://127.0.0.1:8000`.

## Buổi tối

Không cần có điện phát để thử. Chế độ AI tạo lệnh theo điện năng ròng **dự báo**. Ví dụ dự báo phát 0 kW, tải 0,12 kW → mua 10 Wh, dù số đo tải gần nhất 0,06 kW (5 Wh). Model hiện là bản tham khảo huấn luyện dữ liệu tổng hợp PV 4 kW; chưa hiệu chuẩn cho bộ pin 3 W, nên cần đối chiếu dự báo với số đo thực. Chế độ Arduino phát 0, tải lớn hơn 0 sẽ tạo đề xuất mua bằng điện năng thiếu đo được. Chính sách `measured-net-next5m-v1` dùng điện năng ròng của khoảng gần nhất để ước lượng khoảng tiếp theo; đây là persistence từ số đo, không phải dự báo AI.

Hợp đồng dùng Wh nguyên: lấy phần nguyên của điện năng, không làm tròn lên và không tự nhân hệ số. Tải ròng 60 W trong 5 phút → mua 5 Wh. Tải 3 W → 0,25 Wh → giữ nguyên; cần khoảng 12 W ròng/5 phút để có 1 Wh. Phát và tải cùng bằng 0 cũng giữ nguyên. Chỉ dùng tải trong giới hạn phần cứng; ngưỡng này là đơn vị phần mềm, không phải hướng dẫn đấu tải.

11 hộ dùng **mô hình nắng ảo** để có bên bán cả khi thử lúc đêm. Thời gian phiên theo số đo ESP32; thời gian mô hình của đối tác ghi riêng là `model_timestamp` với `virtual_profile=daytime_counterparty`. Điều này không đại diện nguồn điện mặt trời thật vào ban đêm.

## Bằng chứng và giới hạn

ESP32 → broker LAN → backend SQLite/API → cầu nối nguồn Nhà 1 → MQTT phiên thử → ví thử nghiệm ký lệnh → smart contract khóa tiền/khớp/thanh toán. ESP32 chưa tự ký giao dịch Web3. Cầu nối chạy trên máy tính và không gửi lệnh relay/actuator.

Lệnh AI Nhà 1 có `basis=esp32_forecast` (enum 0), chính sách `edge-ai-next5m-v1`; bằng chứng chứa số đo đầu vào và toàn bộ dự báo/model/device. Lệnh Arduino có `basis=esp32_telemetry` (enum 3), hash nguyên bản số đo và chính sách, `source_id` theo event gốc. Lưu `esp32-source.json`, `mqtt-sources.json`, `evidence/*.json`, receipts và `report.json` trong thư mục lượt. Một event không thể tạo lệnh thứ hai trong cùng triển khai, kể cả đổi phiên. Telemetry quá 360 giây kể từ lúc nhận, hoặc thời gian mẫu quá 660 giây, bị chặn trước ký lệnh. Dự báo quá 360 giây, sai khoảng đích hoặc đã hết khoảng đích cũng bị chặn. Source ID của AI cố định theo thiết bị và event gốc để chặn đặt lại bằng cùng dự báo trong cùng triển khai.

Giao điện giữa các hộ vẫn dùng công tơ ảo có cặp chỉ số nhập/xuất Wh; `physical_delivery_verified=false`. Báo cáo và giao diện phân biệt nguồn đo thật với giao điện mô phỏng. Không dùng kết quả này để tuyên bố điện đã truyền vật lý giữa các nhà.

## Kiểm thử

```powershell
$env:SOLAR_TEST_PYTHON=(Resolve-Path '.venv-runtime/Scripts/python.exe').Path
npm.cmd run test:hybrid
npm.cmd run dashboard:build
npm.cmd run test:hybrid:ui
```

Kiểm thử dùng backend **fixture**, dữ liệu nguồn giả lập ghi rõ trong `build/hybrid-fixture-test`, nhưng MQTT, hợp đồng, chữ ký và receipts chạy thật trên local. Kiểm tra timestamp mô phỏng quá khứ/future được dùng đúng với thời điểm nhận, nguồn 5s bị chặn trong chế độ thật; kiểm tra AI tạo lượng lệnh khác số đo gần nhất, chặn sai model/run/event/demo/thiếu mẫu/dự báo cũ/sửa hash; kiểm tra phát 0 → mua, tải 0/sub-Wh → giữ nguyên, chặn demo/số đo cũ/sửa hash/lặp nguồn, đúng 11 agent mô phỏng, bảo toàn token, escrow cuối 0 và UI desktop/mobile. Các báo cáo fixture không được đưa vào báo cáo live mới nhất.
