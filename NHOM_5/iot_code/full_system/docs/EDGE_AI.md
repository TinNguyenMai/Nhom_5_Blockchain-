# ESP32 Edge AI — hướng dẫn triển khai trên Windows

Bản này bổ sung **AI chạy trực tiếp trên một ESP32 cho Nhà 1**. Mô hình và dữ liệu kiểm tra đã được chuẩn bị sẵn. Bạn cần cấu hình Wi-Fi/MQTT, biên dịch và nạp firmware vào board của mình. Chưa có kết quả đo trên board thật trong gói này; xem `EDGE_VALIDATION.md` để phân biệt phần đã kiểm tra và phần cần bạn đo.

## 1. Bản này làm gì?

Simulator trên máy tính tạo số đo → MQTT chuyển số đo Nhà 1 đến ESP32 → ESP32 tự chạy mô hình INT8 → MQTT đưa dự báo về màn hình theo dõi. Subscriber vẫn có thể ghi số đo như Phase 1B.

| Thành phần | Vai trò |
|---|---|
| Simulator Python | Nguồn dữ liệu IoT mô phỏng cho 3 nhà |
| Mosquitto | Chuyển bản tin giữa máy tính và board |
| ESP32 / ESP32-S3 | Giữ 12 số đo, chạy TensorFlow Lite Micro và dự báo khoảng 5 phút tiếp theo của Nhà 1 |
| Edge Monitor | Hiện dự báo, nhận số đo khoảng tiếp theo rồi tính sai số; không cần TensorFlow |
| Dataset 30 ngày | Dùng huấn luyện và đánh giá mô hình trên máy tính |

Board chưa đọc cảm biến hay điều khiển điện. Đây là **suy luận AI trên phần cứng thật, với đầu vào mô phỏng**. Phần smart contract/giao dịch blockchain vẫn là bước tích hợp sau. Dự báo điện dư chỉ là thông tin để đề xuất giao dịch, chưa phải số đo để thanh toán.

Ví dụ: ESP32 nhận đủ các khoảng từ 10:00 đến 10:55 thì dự báo khoảng bắt đầu 11:00. Khi số đo 11:00 được phát, monitor đối chiếu với dự báo đó. Timestamp là đầu khoảng đo; công suất là công suất trung bình xấp xỉ của khoảng 5 phút. Không dùng giờ trên đồng hồ ESP32 để thay cho thời gian giả lập.

## 2. Chuẩn bị

- Một ESP32-S3-DevKitC-1, hoặc ESP32 DevKit dùng chip ESP32 thông thường. Firmware nhỏ này không yêu cầu PSRAM; nếu đã có board, chưa cần mua board khác chỉ vì PSRAM.
- Cáp USB truyền dữ liệu, máy Windows có Python 3.11/3.12 và Mosquitto, Wi-Fi **2,4 GHz** chung mạng với máy tính.
- ESP-IDF **5.4.2**, cài bằng công cụ chính thức của Espressif, kèm driver USB của board.

Target ESP32-S3 đã được biên dịch kiểm tra. ESP32 thông thường có hướng dẫn chọn target bên dưới nhưng chưa được build riêng trong lượt kiểm tra này. Với ESP32-S3-DevKitC-1 có hai cổng USB, dùng cổng USB-to-UART cho cấu hình serial mặc định của bản này.

Giải nén vào đường dẫn ngắn không có dấu cách, ví dụ `C:\solar-lab\p2p-solar-phase1`. Đường dẫn dự án cũ của bạn có `ANOTHER DISK` và `4th YEAR`; dùng thư mục mới cho bản ESP-IDF để tránh lỗi đường dẫn khi build. Giữ bản cũ và CSV gốc để đối chiếu.

`config/homes.json` vẫn là cấu hình của gói nguồn cũ. Demo mới dùng **`config/edge_demo.json`**: Nhà 1 PV 4 kW, tải nền 0,65 kW; Nhà 3 PV 3 kW; thời tiết auto; ngày bắt đầu 01/10/2026; seed riêng. Mô hình được huấn luyện cho Nhà 1 với PV bật và tải ×1. Khi chép sang dự án đang dùng, giữ các tùy chỉnh riêng của bạn ở `homes.json`.

Trong PowerShell thường, tại thư mục gốc dự án:

```powershell
cd C:\solar-lab\p2p-solar-phase1
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Không cần cài TensorFlow để chạy demo bằng board. Mô hình đã nhúng trong `iot_code/firmware/esp32_edge/main/model_data.h`.

## 3. Mở broker cho ESP32

ESP32 không thể dùng `127.0.0.1` của máy tính. Trên ESP32, địa chỉ đó chỉ chính ESP32.

1. Chạy `ipconfig` trên Windows, lấy IPv4 của Wi-Fi đang dùng, ví dụ `192.168.1.10`.
2. Chạy lệnh dưới và thay IP ví dụ bằng IP thật. Script hỏi mật khẩu MQTT của tài khoản `solar_edge` hai lần; ghi nhớ để nhập trong firmware.

```powershell
.\scripts\setup_edge_broker.ps1 -LanIp 192.168.1.10
```

Nếu Mosquitto ở chỗ khác, thêm `-MosquittoDirectory "D:\Tools\mosquitto"`. Nếu PowerShell chặn script tải về, mở file đọc trước, rồi dùng `Unblock-File .\scripts\setup_edge_broker.ps1` và chạy lại; không cần đổi chính sách toàn máy.

3. Dừng cửa sổ broker cũ đang chiếm cổng 1884 bằng Ctrl+C. Khởi động **một** broker với cấu hình mới và giữ cửa sổ này mở:

```powershell
& "C:\Program Files\mosquitto\mosquitto.exe" -c .\.local\mosquitto-edge.conf -v
```

| Chương trình | Địa chỉ broker |
|---|---|
| Simulator, subscriber, panel, Edge Monitor trên máy tính | `127.0.0.1:1884` |
| ESP32 trên cùng Wi-Fi | `mqtt://192.168.1.10:1885`, username `solar_edge`, mật khẩu vừa tạo |

Hai cổng cùng thuộc một broker nên trao đổi được bản tin. Cổng 1884 chỉ mở trên máy tính; 1885 cần xác thực và chỉ cho tài khoản board đọc telemetry Nhà 1, ghi prediction Nhà 1. Cấu hình demo dùng MQTT không mã hóa trên LAN tin cậy; không mở cổng ra Internet.

Nếu Windows Firewall chặn, trên mạng riêng của bạn, tạo rule trong PowerShell **Run as administrator**:

```powershell
New-NetFirewallRule -DisplayName "Solar ESP32 MQTT LAN" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 1885 -Profile Private -RemoteAddress LocalSubnet
```

Wi-Fi trường hoặc khách có thể chặn thiết bị nói chuyện với nhau. Dùng mạng LAN cho phép giao tiếp giữa máy tính và ESP32. Nếu IP máy tính đổi, sửa dòng `listener 1885 ...` trong `.local/mosquitto-edge.conf` và URI trong firmware rồi build/nạp lại. Script không ghi đè file đã có.

## 4. Nạp ESP32

Mở **ESP-IDF 5.4 PowerShell** do bộ cài cung cấp, không dùng terminal đang kích hoạt `.venv` của dự án. Cắm board bằng cáp dữ liệu. Xem cổng COM trong Device Manager.

```powershell
cd C:\solar-lab\p2p-solar-phase1\iot_code\firmware\esp32_edge
idf.py set-target esp32s3
idf.py menuconfig
```

Nếu board là ESP32 DevKit thông thường, thay dòng set-target bằng `idf.py set-target esp32`. Không chọn chip chỉ dựa vào hình dáng board; xem tên module in trên board. Với dòng C3/C6 hoặc board khác, cần chọn đúng target và kiểm tra thêm.

Trong menu **Solar Edge AI**, điền:

| Mục | Giá trị |
|---|---|
| Wi-Fi SSID | Tên mạng Wi-Fi 2,4 GHz |
| Wi-Fi password | Mật khẩu Wi-Fi |
| Broker LAN URI | `mqtt://<IPv4-máy-tính>:1885` |
| MQTT username | `solar_edge` |
| MQTT password | Mật khẩu ở bước 3 |

Lưu cấu hình, thoát menu, chạy (thay COM5 bằng cổng thật):

```powershell
idf.py build
idf.py -p COM5 flash monitor
```

Lần đầu build cần Internet để tải component đã khóa phiên bản. Sau khi nạp, chờ log `SELFTEST PASS`, `Wi-Fi ready`, `MQTT connected`. Nếu board không vào chế độ nạp tự động, giữ BOOT trong lúc bắt đầu kết nối nạp theo hướng dẫn board. Thoát serial monitor bằng **Ctrl+]**.

`sdkconfig` lưu cấu hình Wi-Fi/MQTT trên máy bạn và firmware chứa thông tin kết nối. File này cùng `.local/` đã được loại khỏi Git; không gửi kèm mật khẩu khi chia sẻ dự án. Bộ ZIP bàn giao không chứa thông tin mạng của bạn.

## 5. Chạy demo đúng thứ tự

Broker và ESP32 đã kết nối. Các lệnh sau chạy trong **PowerShell thường tại thư mục gốc dự án**, mỗi chương trình một cửa sổ.

**Cửa sổ 1 — mở màn hình AI trước khi chạy simulator:**

```powershell
.\.venv\Scripts\python.exe -m iot_code.edge_monitor
```

**Cửa sổ 2 — lưu số đo demo nếu cần:**

```powershell
.\.venv\Scripts\python.exe -m iot_code.subscriber --config config\edge_demo.json --output data\esp32_demo_telemetry.csv
```

CSV này chỉ dùng cho demo. Khi muốn lượt demo có CSV riêng, chọn tên file mới; không trỏ subscriber về `training_30days.csv`.

**Cửa sổ 3 — chạy 1 ngày giả lập, tự dừng sau 288 khoảng:**

```powershell
.\.venv\Scripts\python.exe -m iot_code.simulator --config config\edge_demo.json --dataset --steps 288 --interval 1
```

Một khoảng = 300 giây giả lập; simulator chờ khoảng 1 giây thực giữa các đợt, cộng thời gian xử lý/gửi MQTT. Cả lượt mất khoảng 5 phút thực. Chờ đủ 12 số đo, khoảng 12 giây thực đầu tiên, để có dự báo. Sau đó mỗi số đo mới tạo một dự báo mới.

- Giữ auto và không chỉnh PV/tải khi đo chất lượng mô hình này. `--dataset` khóa các lệnh điều khiển trong lượt demo.
- Không dùng `--interval 0` khi trình diễn với board. Nếu có log `Queue full` hoặc nhiều dự báo `late`, tăng `--interval 2` hoặc `5`.
- Dừng sớm bằng Ctrl+C ở simulator. Sau khi simulator kết thúc, chờ monitor cập nhật rồi đóng cửa sổ monitor; Ctrl+C subscriber. Có thể giữ broker chạy cho lượt sau.
- Nếu muốn xem bảng 3 nhà, mở thêm `.\.venv\Scripts\python.exe -m iot_code.panel`. Panel tự nhận cấu hình đang chạy từ simulator.

Trên Edge Monitor, `Nguồn: esp32` là luồng board gửi; `Phát/Tải/Dư-thiếu` là **dự báo khoảng đích**, còn khu vực đối chiếu là **số đo của khoảng đã có kết quả**. Số âm ở sai số nghĩa là dự báo thấp hơn số đo. Suy luận µs đo riêng lệnh chạy mô hình, không bao gồm Wi-Fi/MQTT.

## 6. File được tạo và cách đánh giá

Mỗi lần mở monitor tự tạo thư mục mới `data/edge_<thời-gian>_<mã>`:

| File | Nội dung |
|---|---|
| `predictions.csv` | Mọi dự báo hợp lệ nhận được, thời gian đích, model, device, inference_us, RAM, clipping |
| `scores.csv` | Dự báo đã có số đo đích; sai số AI và sai số cách giữ nguyên số đo gần nhất |
| `summary.json` | MAE/RMSE, số lượng mẫu theo thiết bị/model; ghi khi đóng monitor bình thường |

Monitor bỏ trùng bản tin QoS1. Dự báo đến sau số đo đích vẫn được ghi với `late=True`, nhưng loại khỏi thống kê chất lượng dự báo trực tiếp. Mẫu không có số đo để đối chiếu không được tính là dự báo đúng. Dự báo cuối lượt thường còn chờ vì simulator không phát khoảng kế tiếp nữa. Giới hạn bộ đệm là 2.000 số đo/chờ ghép; theo dõi `pending_evicted` khi chạy lâu hoặc mất gói.

Mô hình hiện tại: MLP `53 → 32 → 16 → 2`, 2.290 tham số. 48 đầu vào là 12 lịch sử × 4 đại lượng (phát, tải, bức xạ, mây); 5 đầu vào là sin/cos thời gian và cờ cuối tuần. Mô hình học độ thay đổi so với số đo gần nhất; dự báo cuối = số đo gần nhất + thay đổi dự đoán, chặn dưới ở 0. Mạng nơ-ron chạy INT8; chuẩn bị đặc trưng và đổi kết quả về kW dùng số thực.

Chia theo thời gian: 01–20/09 huấn luyện; 21–25/09 chọn mô hình; 26–30/09 kiểm tra. Không trộn ngẫu nhiên trước khi chia. Cửa sổ đầu kỳ kiểm tra được dùng lịch sử đã quan sát từ cuối kỳ trước, giống chạy thực; không dùng số đo tương lai. Hệ số chuẩn hóa đầu vào là đơn vị vật lý cố định; độ chuẩn hóa đầu ra và dữ liệu hiệu chuẩn INT8 chỉ lấy từ tập train.

Kết quả trên 1.440 khoảng kiểm tra 5 ngày, gồm cả ngày và đêm:

| Phương pháp | MAE điện phát | MAE tải |
|---|---:|---:|
| Giữ nguyên số đo gần nhất | 0,03353 kW | 0,04986 kW |
| MLP FP32 trên máy tính | 0,02872 kW | 0,03671 kW |
| MLP INT8 trên máy tính | 0,02868 kW | 0,03707 kW |

INT8 giảm MAE khoảng 14,5% cho phát và 25,6% cho tải so với baseline. Riêng 720 khoảng ban ngày, MAE điện phát INT8 là 0,05649 kW, so với baseline 0,06692 kW; cần báo cáo cả con số này để các khoảng ban đêm bằng 0 không che sai số ban ngày. File TFLite giảm từ 11.084 xuống 5.832 byte, khoảng 47,4%; không nói giảm 4 lần vì file còn metadata và bias. Chi tiết ở `ai_model/artifacts/evaluation.json`.

Các con số trên chứng minh mô hình học được dữ liệu của simulator này; chưa chứng minh độ chính xác ngoài thực tế. Dữ liệu chỉ 30 ngày, một simulator, một Nhà 1, không có dữ liệu cảm biến thật và thay đổi mùa. Không suy diễn “độ chính xác 97%” từ MAE. Mô hình chưa được huấn luyện cho PV tắt, tải tăng mạnh hay công suất lắp đặt khác. `clipped_features > 0` là dấu hiệu đầu vào vượt vùng lượng tử, cần xem lại cấu hình/dữ liệu.

## 7. Huấn luyện lại khi cần

Không cần bước này để nạp demo. Đặt bản sao dataset vào `data/training_30days.csv`, giữ nguyên CSV gốc của bạn. Dùng môi trường Python riêng cho AI:

```powershell
py -3.12 -m venv .venv-ai
.\.venv-ai\Scripts\python.exe -m pip install -r ai_model\requirements.txt
.\.venv-ai\Scripts\python.exe -m ai_model.train --csv data\training_30days.csv
.\.venv-ai\Scripts\python.exe -m ai_model.evaluate --csv data\training_30days.csv
```

Trainer hiện yêu cầu một lượt đủ 30 ngày của Nhà 1, bước 300 giây, bắt đầu nửa đêm. Nó xuất `.keras`, FP32 TFLite, INT8 TFLite, metadata, metrics, vector self-test và cập nhật `model_data.h`. Sau khi huấn luyện lại, build/nạp firmware lại để board dùng model mới. Lưu model/metrics cũ trước khi thay thế nếu cần so sánh; bản CSV đầu vào không bị sửa.

Để chạy lại việc đánh giá model bàn giao mà không huấn luyện, chỉ dùng lệnh `ai_model.evaluate`; mã kiểm tra SHA-256 để không vô tình dùng dataset khác. Gói bàn giao không chép lại toàn bộ dataset gốc; hash nằm trong metadata.

## 8. Bằng chứng nên đưa vào báo cáo/video

1. Quay board thật, serial log `SELFTEST PASS`, model_version và kết nối MQTT.
2. Chạy simulator + monitor bằng `.venv` chỉ có paho-mqtt; không chạy `ai_model.pc_reference`.
3. Quay dự báo xuất hiện trước số đo của khoảng đích và kết quả đối chiếu sau đó.
4. Lưu logs/CSV/summary của lượt board thật; báo cáo median/p95 `inference_us`, `arena_used_bytes`, `free_heap_bytes`, MAE/RMSE và số mẫu/late. Không điền số đo giả cho board.
5. Đưa bảng FP32/INT8/baseline, kích thước model và giới hạn dữ liệu mô phỏng vào báo cáo.

`ai_model.pc_reference` chỉ dùng kiểm thử luồng MQTT khi chưa có board; nó gửi `device_kind=pc_reference`, monitor mặc định không nhận loại này. Không dùng kết quả đó để tuyên bố đã chạy ESP32. INT8/Edge AI đáp ứng hướng triển khai của hạng mục bạn trích dẫn; điểm số còn phụ thuộc demo, báo cáo và đánh giá của giảng viên. Bản này chưa triển khai TEE/MPU hoặc cơ chế phần cứng tin cậy.

## 9. Lỗi thường gặp

| Triệu chứng | Cách kiểm tra |
|---|---|
| Python báo WinError 10061 | Broker phải chạy trước; Python dùng 1884; xem broker có báo cổng đã bị chiếm không |
| ESP32 không kết nối | SSID 2,4 GHz, URI là IPv4 máy tính:1885; mật khẩu MQTT; firewall; mạng có chặn thiết bị không |
| Có `SELFTEST PASS` nhưng chưa có dự báo | Chờ 12 số đo Nhà 1; đúng topic, bước 300 giây, timestamp +07:00 |
| Chạy lại simulator và phải chờ lại | Bình thường: run_id mới thì không được trộn lịch sử lượt cũ |
| Đứt mạng hoặc mất khoảng | Board bỏ cửa sổ không liên tục và tích lũy lại 12 mẫu; CSV thiếu không tự được bù |
| Phát gần 0 vào buổi tối | Thời gian giả lập quyết định bức xạ. Chọn sunny không làm ban đêm có nắng |
| `Feature bị chặn` hoặc dự báo xấu sau đổi tải/PV | Trở về edge_demo.json hoặc thu dữ liệu mới và huấn luyện lại |
| Sai số nhỏ nhưng chưa có điểm đo trên ESP32 | Metrics đóng gói là INT8 trên CPU; cần lượt board thật để xác nhận sai số/độ trễ/RAM thực tế |

Tham khảo chính thức: [ESP-IDF 5.4.2](https://docs.espressif.com/projects/esp-idf/en/v5.4.2/esp32s3/get-started/index.html), [esp-tflite-micro 1.3.3~1](https://components.espressif.com/components/espressif/esp-tflite-micro/versions/1.3.3~1/readme), [full integer quantization](https://ai.google.dev/edge/litert/models/post_training_integer_quant).
