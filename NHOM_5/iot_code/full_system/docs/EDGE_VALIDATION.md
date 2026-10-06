# Kiểm chứng bản ESP32 Edge AI

Ngày chuẩn bị: 23/09/2026. Phạm vi: mô hình Nhà 1, dự báo công suất phát và tải của khoảng 5 phút kế tiếp.

## Những gì đã chạy

- Huấn luyện thật trên CSV 30 ngày đã cung cấp, chỉ lấy Nhà 1. SHA-256 của CSV: `3447ab9c797392fc9ad7a580aeb0c7f828ec8b564d4efac97dc43d49872af388`.
- 5.748 cửa sổ train, 1.440 validation, 1.440 test. Thiếu 12 nhãn đầu train do cần một giờ lịch sử. Nhãn không vượt ranh giới tập; lịch sử chỉ lấy quá khứ, có thể nằm ở tập trước.
- Xuất FP32 và INT8 thật, chạy lại dự báo toàn bộ tập test trên TFLite CPU. Không có chỉ số board được điền thay bằng chỉ số CPU.
- Kiểm tra model INT8 có input/output int8, không có tensor float32 và chỉ dùng toán tử `FULLY_CONNECTED`. Model là MLP nhỏ có 2.290 tham số.
- **27 kiểm thử đạt trên Linux**, gồm 20 kiểm thử Phase 1B và 7 kiểm thử Edge AI. Hai kiểm thử tích hợp chạy broker MQTT cục bộ thật bằng amqtt; module dự báo thử được ghi rõ `pc_reference`.
- Tích hợp Edge: phát 30 khoảng, nhận 19 dự báo sau 12 mẫu khởi động, đối chiếu đủ 18 dự báo, 1 dự báo cuối chờ số đo kế tiếp; không có dự báo đến trễ trong ca thử đó.
- Biên dịch và chạy chương trình kiểm tra C++ trên PC, so khớp vector đặc trưng và lượng tử hóa với Python tại ban ngày, qua nửa đêm, đổi ngày cuối tuần và năm nhuận; kiểm tra cả bản bật tối ưu hóa `-O2`.
- Kiểm tra trùng bản tin, bản tin cũ, đổi run, mất khoảng, timestamp/múi giờ sai, số NaN, sai step; kiểm tra monitor không tính trùng và loại dự báo đến trễ khỏi thống kê trực tiếp.
- Kiểm tra CSV huấn luyện không bị ghi sửa và cấu hình demo hợp lệ.

## Mô hình bàn giao

| Mục | Giá trị |
|---|---|
| Model version | `home01-next5m-int8-0f22aaf7d1e0` |
| SHA-256 INT8 | `0f22aaf7d1e0996b6b614fe4021e175be2e3ead351aaf7e68180097397222195` |
| FP32 / INT8 | 11.084 / 5.832 byte |
| Test MAE điện phát FP32 / INT8 | 0,02872 / 0,02868 kW |
| Test MAE tải FP32 / INT8 | 0,03671 / 0,03707 kW |
| Test RMSE điện phát INT8 | 0,05418 kW |
| Test RMSE tải INT8 | 0,04556 kW |
| Daylight-only MAE phát INT8 / baseline | 0,05649 / 0,06692 kW, 720 mẫu |
| Arena dự trù trong firmware | 32.768 byte; đây là bộ đệm cấu hình, chưa phải RAM đã đo trên board |

Xem `ai_model/artifacts/metadata.json`, `metrics.json`, `evaluation.json`, `selftest.json`. Vector self-test lấy từ tập train; firmware kiểm tra kết quả INT8 lúc khởi động với dung sai 1 mức lượng tử. `SELFTEST PASS` phải được xác nhận thêm trên board thật.

## Biên dịch firmware

Môi trường kiểm tra: ESP-IDF 5.4.2, esp-tflite-micro 1.3.3~1, esp-nn 1.4.1, Xtensa GCC 14.2.0. Phiên bản component được giữ trong `dependencies.lock`.

**Đã build thành công target `esp32s3`, gồm toàn bộ Wi-Fi/MQTT và mô hình.** Dùng SSID/mật khẩu mẫu không rỗng khi kiểm tra build để các nhánh kết nối không bị trình biên dịch loại bỏ. Ảnh ứng dụng là 939.408 byte, phân vùng ứng dụng 1.536.000 byte, còn trống 39%. Đây là kích thước flash, không phải RAM hoặc tốc độ suy luận.

Không có cảnh báo/lỗi trong mã ứng dụng ở lần build cuối. Thư viện bên ngoài có một số cảnh báo shadow khi biên dịch. Đã sửa cảnh báo kiểm tra độ dài bộ đệm định dạng timestamp do Xtensa GCC phát hiện. Model nhúng trong `model_data.h` đã đối chiếu byte-for-byte với `model_int8.tflite`.

ESP32 DevKit thông thường dùng cùng mã và chọn `idf.py set-target esp32`; target đó chưa được build riêng trong lượt kiểm tra này. Với ESP32-S3, gói nguồn đã qua biên dịch; bạn vẫn cần nhập Wi-Fi/MQTT của mình và build/nạp tại máy đang cắm board. Thư mục build, cấu hình kết nối mẫu và binary thử nghiệm không nằm trong ZIP.

## Phần cần kiểm tra trên máy và board của bạn

- Nhập Wi-Fi/MQTT, build với đúng target, nạp qua đúng COM; kiểm tra boot/self-test trên chip thật.
- Chạy PowerShell tạo broker trên Windows, xác nhận xác thực và firewall của mạng đang dùng.
- Kiểm tra giao diện Tkinter trên màn hình Windows của bạn; logic thu nhận/đối chiếu đã chạy qua chế độ headless.
- Ghi số đo độ trễ suy luận, arena dùng thực, free heap và chất lượng dự báo trên firmware thật. Chưa có chứng cứ nạp board hoặc số đo này trong gói bàn giao.
- Cảm biến/tấm pin thật, mất Wi-Fi trên phần cứng, nhiều board, TLS, TEE/MPU và smart contract chưa thuộc bản triển khai này.

## Chạy lại kiểm tra phần mềm

Sau khi cài `ai_model/requirements.txt` trong môi trường AI:

```powershell
.\.venv-ai\Scripts\python.exe -m pip install amqtt==0.11.3
.\.venv-ai\Scripts\python.exe -m unittest discover -s tests -v
.\.venv-ai\Scripts\python.exe -m ai_model.evaluate --csv data\training_30days.csv
```

Ca tích hợp Edge dùng tín hiệu POSIX nên được skip trên Windows; ca so khớp C++ được skip nếu không có g++. Các ca cần TensorFlow/amqtt cũng được skip khi thiếu dependency. Con số 27 đạt ở trên là kết quả môi trường Linux có đủ dependency, không phải tuyên bố toàn bộ đã chạy trên Windows.

Hai kiểm thử MQTT dùng lớp broker hỗ trợ đóng mọi TCP stream khi teardown để tránh chờ vô hạn của Server.wait_closed trên Python 3.12. Lớp này chỉ phục vụ vòng đời broker thử nghiệm; không thay đổi nội dung bản tin hoặc logic dự báo.
