# Phase 1B - Nhà có thể cấu hình và mô phỏng có thể điều khiển

## Kết quả của bước này

- Giữ nguyên luồng Python → MQTT Mosquitto → Subscriber → CSV.
- Cấu hình số nhà, tên nhà, công suất lắp đặt và tải nền trong `config/homes.json`.
- Bảng điều khiển desktop bằng Tkinter: số đo từng nhà, hình nhà đang chọn,
  tạm dừng/tiếp tục, tốc độ phát bản tin, thời tiết, bật/tắt điện mặt trời và hệ số tải.
- Các nút thật sự gửi lệnh MQTT tới simulator; số liệu trên màn hình đến từ MQTT.
  Panel không tự sinh số để hiển thị.
- Mỗi lượt chạy lưu cấu hình và nhật ký điều khiển để biết dữ liệu được tạo như thế nào.
- Tách chế độ demo có điều khiển và chế độ tạo dataset khóa điều khiển.

Đây là bảng điều khiển kỹ thuật chạy trên máy tính bằng Python, không phải website
React cuối cùng. Chưa có AI, FastAPI, ví MetaMask hay giao dịch blockchain ở bước này.

## 1. Cập nhật dự án hiện tại, không mất dữ liệu

1. Dừng simulator, subscriber và panel nếu đang chạy bằng Ctrl+C hoặc đóng panel.
2. Giải nén bản cập nhật ra một thư mục tạm.
3. Mở thư mục `p2p-solar-phase1` bên trong bản giải nén, chép các file/thư mục trong
   đó vào thư mục dự án đang mở trong VS Code. Đồng ý thay thế các file mã nguồn.
4. Gói cập nhật không chứa `.venv` và không chứa `data`, vì vậy không cần xóa hai
   thư mục này. Nếu bạn đã tự sửa mã, lưu bản sao các file mình sửa trước khi chép.
5. Kiểm tra `config`, `iot_code`, `requirements.txt` nằm cùng cấp. Tránh tạo nhầm
   thêm một thư mục `p2p-solar-phase1` lồng trong dự án cũ.

Trong terminal PowerShell tại thư mục dự án:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Không có thư viện chạy mới ngoài `paho-mqtt`. Tkinter thường đi kèm bộ cài Python
Windows đầy đủ; xem phần xử lý lỗi nếu máy thiếu Tcl/Tk.

Nếu bắt đầu ở thư mục mới thay vì cập nhật dự án cũ, tạo môi trường trước:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

## 2. Chạy demo bằng 4 terminal trong VS Code

Mỗi terminal phải đứng ở thư mục dự án có `requirements.txt`.
Tạo terminal bằng Terminal → New Terminal hoặc nút `+` của khung terminal.

### Terminal 1 - Broker

Nếu Mosquitto của đồ án đã chạy ở 127.0.0.1:1884, giữ cửa sổ đó và không chạy thêm
broker thứ hai. Nếu chưa có broker:

```powershell
& "C:\Program Files\mosquitto\mosquitto.exe" -c .\mosquitto.conf -v
```

### Terminal 2 - Subscriber

```powershell
.\.venv\Scripts\python.exe -m iot_code.subscriber --output data\phase1b_demo.csv
```

Chờ `READY solar/+/telemetry`. File mới này tách demo Phase 1B khỏi dữ liệu cũ.
Nếu file đã có, chương trình nối thêm dữ liệu; không ghi đè các dòng cũ.

### Terminal 3 - Bảng điều khiển

```powershell
.\.venv\Scripts\python.exe -m iot_code.panel
```

Cửa sổ `P2P Solar Energy Trading - Phase 1B` mở ra. Ban đầu hiện chờ simulator;
các nút điều khiển bị khóa cho đến khi nhận được trạng thái từ simulator.

### Terminal 4 - Simulator khởi động ở trạng thái tạm dừng

```powershell
.\.venv\Scripts\python.exe -m iot_code.simulator --paused
```

Trong khoảng một vài giây, panel hiện trạng thái `paused` và danh sách nhà từ JSON.
Nhấn **Tiếp tục** để bắt đầu. Subscriber nhận dữ liệu và panel cập nhật số đo.
Chỉ chạy **một simulator** trên broker này tại một thời điểm.

Không chạy `simulator.py` bằng nút Run Python File. Dùng lệnh `-m iot_code.simulator`
để các import trong package hoạt động đúng.

## 3. Thử các chức năng

| Thao tác | Kết quả mong đợi |
| --- | --- |
| Nhấn Tiếp tục | Đồng hồ giả lập tiến lên, các nhà có số đo, CSV được thêm dòng |
| Nhấn Tạm dừng, chờ xác nhận | Không phát đợt đo mới, đồng hồ giả lập đứng yên, giữ số đo cuối trên màn hình |
| Đổi Giây/đợt từ 5 sang 1 rồi nhấn Đổi tốc độ | Thời gian chờ thực giảm; mỗi khoảng giả lập vẫn 300 giây |
| Chọn sunny, nhấn Đổi thời tiết | Trời ít mây; điện phát cao hơn trường hợp mây dày ở cùng giờ ban ngày |
| Chọn cloudy hoặc rainy, nhấn Đổi thời tiết | Tăng độ che phủ mây, giảm điện phát ở các đợt đo sau |
| Chọn một nhà, chọn Tắt trong PV muốn đặt, nhấn Đổi trạng thái PV | Công suất phát của nhà đó bằng 0 từ đợt đo tiếp theo; không đổi tải |
| Chọn Bật, nhấn Đổi trạng thái PV | PV bật lại; chỉ phát điện nếu có bức xạ và công suất lắp đặt > 0 |
| Đặt Hệ số tải = 2, nhấn Đổi tải | Tải của nhà đó xấp xỉ gấp đôi kịch bản hệ số 1; không đổi PV |
| Nhấn Dừng lượt chạy | Simulator kết thúc và lưu tổng kết; muốn chạy lại phải chạy lại lệnh ở terminal 4 |

`Tiếp tục` chỉ tiếp tục một simulator đang tạm dừng; không mở lại tiến trình đã kết thúc.
Đóng cửa sổ panel không tự dừng simulator hoặc subscriber.

Để so sánh thời tiết công bằng, so sánh cùng giờ hoặc gần nhau, vì góc mặt trời cũng
thay đổi khi đồng hồ giả lập tiến lên. Ban đêm, chọn sunny vẫn không tạo ra điện.

Tạm dừng có hiệu lực ở ranh giới giữa hai đợt đo. Nếu một đợt đang gửi dữ liệu cho
các nhà, simulator gửi xong đợt đó rồi mới xác nhận tạm dừng. Khi đã có xác nhận,
không có đợt mới; bản tin của đợt vừa hoàn thành có thể còn đang tới subscriber.

Số đo đang hiển thị là số đo cuối, có timestamp riêng. Khi tạm dừng mà đổi PV/tải,
cấu hình áp dụng ngay nhưng số đo chỉ cập nhật sau khi nhấn Tiếp tục.

Ô `PV muốn đặt` là lựa chọn chưa gửi; dòng `PV BẬT/TẮT (simulator)` là trạng thái
simulator báo về. Ban đêm PV vẫn có thể BẬT nhưng phát 0 kW do bức xạ bằng 0.
Panel giải thích trường hợp này và trường hợp nhà chưa lắp PV. Xem `PV_UPDATE.md`
để cập nhật chỉ file panel mà không thay cấu hình hoặc dữ liệu.

## 4. Thêm nhà thứ tư

Dừng simulator và subscriber trước khi chỉnh số nhà. Mở `config/homes.json`.
Trong danh sách `homes`, thêm dấu phẩy sau object nhà thứ ba, rồi thêm object sau
trước dấu `]` đóng danh sách:

```json
{
  "id": "home_04",
  "name": "Nhà 4",
  "pv_kw": 3.0,
  "base_load_kw": 0.8,
  "pv_enabled": true,
  "load_multiplier": 1.0
}
```

Lưu JSON rồi chạy lại subscriber và simulator. Panel đang mở sẽ nhận lượt chạy
mới và cập nhật danh sách nhà; không cần sửa `model.py` hay `subscriber.py`.

| Tham số | Ý nghĩa |
| --- | --- |
| `id` | Mã duy nhất, ví dụ home_04; không dùng khoảng trắng, dấu /, + hoặc # |
| `name` | Tên hiển thị, dùng được tiếng Việt |
| `pv_kw` | Công suất lắp đặt giả định; đặt 0 cho nhà chỉ tiêu thụ |
| `base_load_kw` | Tải nền trước khi áp dụng đỉnh sáng/tối và nhiễu |
| `pv_enabled` | Cho phép hệ thống điện mặt trời phát điện hay không |
| `load_multiplier` | Hệ số nhân nhu cầu, từ 0.1 đến 5 |

Xóa nhà: xóa toàn bộ object tương ứng, chú ý dấu phẩy; phải giữ ít nhất một nhà.
Đổi thông số lắp đặt: sửa `pv_kw` hoặc `base_load_kw` trong JSON và khởi động lại.
Giới hạn hiện tại là 100 nhà. Bảng có thể cuộn bằng con lăn khi danh sách dài.

Điều khiển PV/tải trên panel chỉ áp dụng trong lượt chạy hiện tại, không ghi đè
JSON. Muốn lưu lâu dài, chỉnh JSON. Khi thêm/xóa nhà, phải khởi động lại cả
subscriber và simulator để chúng dùng cùng danh sách ID.

## 5. Hai loại thời gian và cấu hình mô phỏng

Trong `simulation` của JSON:

```json
{
  "start": "2026-09-01T12:00:00+07:00",
  "step_seconds": 300,
  "publish_interval_seconds": 5,
  "seed": 42,
  "weather": "auto"
}
```

- `start`: thời điểm giả lập bắt đầu. Mặc định là trưa để dễ quan sát điện phát.
- `step_seconds`: thời lượng mỗi khoảng đo giả lập, từ 1 đến 300 giây.
- `publish_interval_seconds`: khoảng nghỉ thực giữa hai đợt gửi; thời gian gửi bản
  tin cộng thêm vào khoảng này. 5 giây thực mặc định ứng với 300 giây giả lập.
- `seed`: hạt giống sinh số ngẫu nhiên, giúp tái lập kịch bản với cùng cấu hình.
- `weather`: auto = mây biến đổi; sunny = mây 5%; cloudy = mây 65%; rainy = mây 95%.

`rainy` hiện chỉ là preset mây dày, chưa phải mô hình lượng mưa vật lý.
Công suất vẫn là mô hình gần đúng; chưa có đo dòng/áp thật, pin lưu trữ hay tổn hao
lưới điện. Nhiệt độ được tạo để ghi nhận nhưng chưa tác động trực tiếp tới hiệu suất PV.

Đổi Giây/đợt trên panel không đổi công thức kWh: điện năng luôn được tính từ công
suất và `step_seconds`, không phải từ tốc độ chạy trên máy tính.
Tham số dòng lệnh `--start`, `--interval`, `--step-seconds`, `--seed` ghi đè JSON
cho lượt chạy đó nhưng không sửa JSON trên đĩa.

## 6. Nhật ký giúp hiểu dữ liệu và tái lập

CSV vẫn giữ 17 cột như Phase 1A. Mỗi simulator có `run_id` mới.
Thư mục `data/runs` chứa thêm:

- `<run_id>.json`: cấu hình có hiệu lực, seed, chế độ chạy, số khoảng dự kiến.
- `<run_id>.commands.jsonl`: từng lệnh điều khiển, kết quả và khoảng bắt đầu áp dụng.
- `<run_id>.summary.json`: tổng kết số đợt, số bản tin gửi, trạng thái cuối.

Không trộn các lượt chạy khác cấu hình thành một chuỗi thời gian liên tục khi
train AI. Phải nhóm theo `run_id` và `household_id`. Các lệnh đổi tải/thời tiết
được lưu riêng để phân biệt kịch bản can thiệp với kịch bản tự nhiên của mô hình.

Tổng kết đếm số bản tin đã được broker ACK, không chứng minh collector đã ghi đủ CSV.
Luôn kiểm tra CSV ở subscriber. Bản demo chưa có cơ chế nhận bù dữ liệu khi collector
offline và chưa có chữ ký để chứng minh dữ liệu đầu vào là đáng tin cậy.

## 7. Dataset để làm ở bước sau

Sau khi kiểm tra các nút điều khiển, có thể tạo dataset riêng. Dừng simulator và
subscriber của demo trước. Giữ broker. Chạy subscriber, đợi READY:

```powershell
.\.venv\Scripts\python.exe -m iot_code.subscriber --output data\training_30days.csv
```

Chạy simulator ở terminal khác:

```powershell
.\.venv\Scripts\python.exe -m iot_code.simulator --dataset --start "2026-09-01T00:00:00+07:00" --steps 8640 --interval 0 --seed 42 --quiet
```

`--dataset` khóa các lệnh từ panel. `--interval 0` chạy nhanh nhất có thể.
Panel vẫn có thể theo dõi, nhưng chỉ giữ số đo mới nhất để tránh quá tải giao diện.
Không dùng tốc độ làm mới panel để đếm bản tin dataset.

Số dòng kỳ vọng trên một CSV mới khi thu đầy đủ:

`30 ngày × 288 khoảng/ngày × số nhà`.

Với 3 nhà: 25.920 dòng; với 4 nhà: 34.560 dòng. Không cộng hàng tiêu đề.
Nếu đã có file cùng tên, dữ liệu sẽ nối thêm; hãy chọn tên mới cho dataset mới.
Mỗi ngày có 288 khoảng chỉ khi `step_seconds` = 300.

## 8. Kiểm tra và xử lý lỗi

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

Các unit test chạy với dependencies thông thường của dự án. Integration test
tự báo `skipped` khi chưa có aMQTT; người dùng không cần cài aMQTT để chạy demo
Mosquitto. Kiểm thử phát triển có thể cài thêm `amqtt==0.11.3` trong môi trường
Python 3.12 riêng rồi chạy toàn bộ test. Xem `VALIDATION.md` để biết phạm vi đã thử.

| Lỗi / hiện tượng | Cách xử lý |
| --- | --- |
| No module named tkinter hoặc lỗi Tcl/Tk | Mở bộ cài Python → Modify → bật Tcl/Tk and IDLE; kiểm tra bằng `python -m tkinter` |
| Panel mở nhưng chưa thấy nhà | Chạy simulator; chờ trạng thái; kiểm tra cả hai cùng host/port |
| Nút bị khóa | Chưa có simulator, mất kết nối, simulator đã dừng, đang đợi ACK hoặc đang chạy --dataset |
| Đổi số nhà nhưng subscriber SKIP | Dừng/mở lại subscriber để đọc JSON mới, cùng file --config với simulator |
| Invalid JSON / cấu hình sai | Kiểm tra dấu phẩy, ngoặc, ID trùng; JSON dùng true/false, số thập phân dùng dấu chấm |
| Chạy lệnh mới khi simulator cũ vẫn chạy | Dừng lượt cũ trước; dự án chỉ hỗ trợ một simulator hoạt động trên broker này |
| Panel đóng nhưng CSV vẫn tăng | Bình thường: panel là client độc lập; dừng simulator để ngừng tạo số đo |
| Không thấy số liệu vừa thay đổi | Khi paused, nhấn Tiếp tục; xem timestamp của số đo cuối |
| Port 1884 đang được sử dụng | Có thể broker cũ đang chạy; dùng broker đó, không mở thêm một bản |

Broker vẫn chỉ bind 127.0.0.1. Điều khiển hiện không có tài khoản/chữ ký, chỉ dành
cho demo trên cùng máy. Không mở cấu hình anonymous này ra LAN/Internet.

## Nền tảng kỹ thuật

- [Eclipse Paho Python](https://eclipse.dev/paho/clients/python/docs/): vòng lặp MQTT
  chạy ở thread riêng. Callback chỉ chuyển bản tin vào hàng đợi/mailbox.
- [Tkinter](https://docs.python.org/3/library/tkinter.html): UI được cập nhật từ
  thread chính qua `after`; không sửa widget trực tiếp từ callback MQTT.
- Mỗi lệnh có ID, run_id và thời điểm phát; simulator bỏ lệnh quá hạn, bỏ retained
  command và chống áp dụng lại cùng request_id trong bộ nhớ đệm 1.000 lệnh gần nhất.
  Đó là tính đúng đắn của demo, không phải cơ chế xác thực người điều khiển.
