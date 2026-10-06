"""Local desktop MQTT monitor. Tk widgets are touched only by the UI thread."""
import argparse
import json
import threading
import time
import uuid

import paho.mqtt.client as mqtt

from .model import validate_reading


def pv_changes(choice):
    """Only the explicitly selected PV setting belongs in this command."""
    if choice not in ("Bật", "Tắt"):
        raise ValueError("Hãy chọn Bật hoặc Tắt.")
    return {"pv_enabled": choice == "Bật"}


def load_changes(value):
    value = float(value)
    if not 0.1 <= value <= 5:
        raise ValueError("Hệ số tải phải từ 0.1 đến 5.")
    return {"load_multiplier": value}


def pv_status_text(home, reading, status, fresh):
    """Distinguish confirmed configuration from the last measured output."""
    if not fresh or status not in ("running", "paused"):
        return "Trạng thái cũ / lượt chạy đã dừng; chờ simulator để xác nhận PV."
    if home.get("pv_kw", 0) <= 0:
        text = "Nhà này chưa lắp PV (0 kW); chọn Bật vẫn không tạo điện."
    elif not home.get("pv_enabled"):
        text = "PV đang TẮT. Chọn Bật rồi nhấn Đổi trạng thái PV để bật lại."
    elif not reading:
        text = "PV đang BẬT; chờ số đo đầu tiên."
    elif reading["irradiance_w_m2"] <= 0:
        text = "PV đang BẬT nhưng bức xạ của số đo gần nhất = 0 W/m² (ban đêm); chưa phát điện."
    else:
        text = "PV đang BẬT. Công suất hiển thị là số đo gần nhất; lệnh mới thể hiện ở đợt tiếp theo."
    if status == "paused":
        text += " Đang tạm dừng: nhấn Tiếp tục để có số đo mới."
    return text


def command_feedback(command):
    if command["action"] == "home":
        changes = command["changes"]
        if "pv_enabled" in changes:
            value = "BẬT" if changes["pv_enabled"] else "TẮT"
            return f"Simulator xác nhận {command['household_id']}: PV {value}. Số đo cập nhật ở đợt tiếp theo."
        return f"Simulator xác nhận {command['household_id']}: tải ×{changes['load_multiplier']:g}."
    return "Simulator đã áp dụng lệnh; số đo thay đổi ở đợt tiếp theo."


class Mailbox:
    """Coalesce telemetry by topic: fast dataset runs cannot grow a UI queue forever."""
    def __init__(self):
        self.lock = threading.Lock()
        self.values = {}

    def put(self, topic, payload):
        with self.lock:
            if topic not in self.values and len(self.values) >= 250:
                self.values.pop(next(iter(self.values)))
            self.values[topic] = payload

    def take(self):
        with self.lock:
            values, self.values = self.values, {}
        return values


def main():
    import tkinter as tk
    from tkinter import ttk, messagebox

    parser = argparse.ArgumentParser(description="Bang dieu khien desktop Phase 1B.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=1884)
    args = parser.parse_args()
    try:
        root = tk.Tk()
    except tk.TclError as error:
        parser.exit(1, f"Khong mo duoc Tkinter: {error}\nCan desktop va thanh phan Tcl/Tk cua Python.\n")
    root.title("P2P Solar Energy Trading - Phase 1B")
    root.geometry("1120x760")
    root.minsize(980, 720)
    root.configure(bg="#eef3f7")
    style = ttk.Style()
    style.theme_use("clam")
    style.configure("TFrame", background="#eef3f7")
    style.configure("TLabel", background="#eef3f7", font=("Segoe UI", 10))
    style.configure("TButton", font=("Segoe UI", 10), padding=7)
    style.configure("Treeview", rowheight=32, font=("Segoe UI", 10))
    style.configure("Treeview.Heading", font=("Segoe UI", 10, "bold"))
    tk.Label(root, text="SOLAR LAB  /  PHASE 1B", bg="#122b45", fg="white", font=("Segoe UI", 20, "bold"), anchor="w", padx=22, pady=18).pack(fill="x")
    body = ttk.Frame(root, padding=18)
    body.pack(fill="both", expand=True)
    connection_text = tk.StringVar(value=f"Đang kết nối MQTT {args.host}:{args.port}...")
    state_text = tk.StringVar(value="Chờ simulator. Panel không tự tạo dữ liệu.")
    feedback = tk.StringVar(value="Chạy broker → subscriber → simulator --paused; sau đó nhấn Tiếp tục.")
    ttk.Label(body, textvariable=connection_text).pack(anchor="w")
    ttk.Label(body, textvariable=state_text, font=("Segoe UI", 12, "bold")).pack(anchor="w", pady=(8, 10))

    mailbox = Mailbox()
    current = {"state": None, "last_status": 0, "broker": False, "readings": {}, "pending": {}}
    client = mqtt.Client(callback_api_version=mqtt.CallbackAPIVersion.VERSION2, client_id=f"panel-{uuid.uuid4().hex[:12]}", protocol=mqtt.MQTTv311)
    client.reconnect_delay_set(min_delay=1, max_delay=5)

    def on_connect(client, userdata, flags, reason_code, properties):
        mailbox.put("connection", (reason_code == 0, str(reason_code)))
        if reason_code == 0:
            client.subscribe([("solar/+/telemetry", 0), ("solar/simulator/state", 1), ("solar/simulator/+/ack", 1)])

    def on_disconnect(client, userdata, flags, reason_code, properties):
        mailbox.put("connection", (False, str(reason_code)))

    def on_message(client, userdata, message):
        if len(message.payload) > 200000:
            return
        try:
            data = json.loads(message.payload.decode("utf-8"))
            if isinstance(data, dict):
                # Preserve ACKs by request ID, rather than overwriting on a common topic.
                key = message.topic + "/" + str(data.get("request_id")) if message.topic.endswith("/ack") else message.topic
                mailbox.put(key, data)
        except ValueError:
            pass

    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message
    controls = []

    def send(action, **values):
        state = current["state"]
        if current["pending"]:
            feedback.set("Đang chờ xác nhận lệnh trước; vui lòng đợi.")
            return
        if not state or not current["broker"] or time.monotonic() - current["last_status"] > 5 or state.get("status") not in ("paused", "running") or not state.get("controls_enabled"):
            feedback.set("Simulator chưa sẵn sàng, đã dừng hoặc đang khóa điều khiển.")
            return
        if action == "stop" and not messagebox.askyesno("Dừng simulator", "Dừng lượt mô phỏng này? Muốn chạy lại bạn cần mở simulator từ terminal."):
            return
        request_id = uuid.uuid4().hex
        command = {"request_id": request_id, "run_id": state["run_id"], "issued_at": time.time(), "action": action, **values}
        info = client.publish(f"solar/simulator/{state['run_id']}/command", json.dumps(command, allow_nan=False), qos=1, retain=False)
        if info.rc == mqtt.MQTT_ERR_SUCCESS:
            current["pending"][request_id] = {"sent_at": time.monotonic(), "command": command}
            feedback.set(f"Đã gửi {action}; đang chờ simulator xác nhận...")
        else:
            feedback.set(f"Không gửi được lệnh: {mqtt.error_string(info.rc)}")

    toolbar = ttk.Frame(body)
    toolbar.pack(fill="x", pady=(0, 12))
    for label, action in [("Tạm dừng", "pause"), ("Tiếp tục", "resume"), ("Dừng lượt chạy", "stop")]:
        button = ttk.Button(toolbar, text=label, command=lambda a=action: send(a))
        button.pack(side="left", padx=(0, 6))
        controls.append(button)
    interval = tk.StringVar(value="5")
    ttk.Label(toolbar, text="Giây/đợt:").pack(side="left", padx=(10, 3))
    ttk.Spinbox(toolbar, from_=0.1, to=60, increment=0.5, textvariable=interval, width=5).pack(side="left")

    def set_interval():
        try:
            value = float(interval.get())
            if not 0.1 <= value <= 60:
                raise ValueError()
            send("interval", value=value)
        except ValueError:
            feedback.set("Giây/đợt phải từ 0.1 đến 60 (dùng dấu chấm thập phân).")

    button = ttk.Button(toolbar, text="Đổi tốc độ", command=set_interval)
    button.pack(side="left", padx=6)
    controls.append(button)
    weather = tk.StringVar(value="auto")
    ttk.Combobox(toolbar, textvariable=weather, values=["auto", "sunny", "cloudy", "rainy"], state="readonly", width=9).pack(side="left", padx=(8, 0))
    button = ttk.Button(toolbar, text="Đổi thời tiết", command=lambda: send("weather", value=weather.get()))
    button.pack(side="left", padx=6)
    controls.append(button)

    columns = ("name", "solar", "load", "net", "timestamp")
    table = ttk.Treeview(body, columns=columns, show="headings", height=4, selectmode="browse")
    for name, title, width in zip(columns, ["Hộ gia đình", "Phát (kW)", "Tải (kW)", "Dư / thiếu (kW)", "Khoảng đo giả lập"], [160, 110, 110, 140, 255]):
        table.heading(name, text=title)
        table.column(name, width=width, anchor="w" if name in ("name", "timestamp") else "e")
    table.tag_configure("surplus", foreground="#067647")
    table.tag_configure("deficit", foreground="#b42318")
    table.pack(fill="both", expand=True)
    ttk.Label(body, text="Dương = dư điện; âm = thiếu điện. Đây là số đo mô phỏng, chưa phải giao dịch blockchain.").pack(anchor="w", pady=7)

    editor = ttk.Frame(body)
    editor.pack(fill="x", pady=6)
    selected = tk.StringVar()
    ttk.Label(editor, text="Chọn nhà:").pack(side="left")
    home_combo = ttk.Combobox(editor, textvariable=selected, state="readonly", width=15)
    home_combo.pack(side="left", padx=8)
    pv_choice = tk.StringVar(value="Bật")
    ttk.Label(editor, text="PV muốn đặt:").pack(side="left", padx=(12, 4))
    pv_combo = ttk.Combobox(editor, textvariable=pv_choice, values=["Bật", "Tắt"], state="readonly", width=7)
    pv_combo.pack(side="left")

    def set_pv():
        try:
            send("home", household_id=selected.get(), changes=pv_changes(pv_choice.get()))
        except ValueError as error:
            feedback.set(str(error))

    button = ttk.Button(editor, text="Đổi trạng thái PV", command=set_pv)
    button.pack(side="left", padx=10)
    controls.append(button)
    load_editor = ttk.Frame(body)
    load_editor.pack(fill="x", pady=(0, 6))
    multiplier = tk.StringVar(value="1.0")
    ttk.Label(load_editor, text="Hệ số tải của nhà đã chọn:").pack(side="left", padx=(0, 4))
    load_input = ttk.Spinbox(load_editor, from_=0.1, to=5, increment=0.1, textvariable=multiplier, width=6)
    load_input.pack(side="left")

    def set_load():
        try:
            send("home", household_id=selected.get(), changes=load_changes(multiplier.get()))
        except ValueError:
            feedback.set("Hệ số tải phải từ 0.1 đến 5 (dùng dấu chấm thập phân).")

    button = ttk.Button(load_editor, text="Đổi tải", command=set_load)
    button.pack(side="left", padx=12)
    controls.append(button)
    house_text = tk.StringVar(value="Chọn một nhà để theo dõi.")
    ttk.Label(body, textvariable=house_text, font=("Segoe UI", 12, "bold")).pack(anchor="w", pady=(10, 5))
    pv_note = tk.StringVar(value="Chọn Bật/Tắt rồi nhấn Đổi trạng thái PV. Ô chọn chưa phải trạng thái đã áp dụng.")
    pv_note_label = ttk.Label(body, textvariable=pv_note, wraplength=900, foreground="#075985")
    pv_note_label.pack(fill="x", pady=(0, 6))
    pv_note_label.bind("<Configure>", lambda event: pv_note_label.configure(wraplength=max(300, event.width)))
    scene = tk.Canvas(body, height=120, bg="white", highlightthickness=0)
    scene.pack(fill="x")
    scene.create_polygon(35, 62, 90, 20, 145, 62, fill="#122b45", outline="")
    scene.create_rectangle(48, 62, 132, 112, fill="#e5edf5", outline="")
    scene.create_rectangle(79, 80, 103, 112, fill="#7798b8", outline="")
    scene.create_polygon(87, 30, 118, 49, 103, 55, 75, 37, fill="#2196a5", outline="white")
    meter_text = scene.create_text(175, 52, anchor="w", text="Chờ dữ liệu từ MQTT...", font=("Segoe UI", 12), fill="#122b45")
    weather_text = scene.create_text(175, 87, anchor="w", text="", font=("Segoe UI", 10), fill="#54677a")
    ttk.Label(body, textvariable=feedback, wraplength=1000, foreground="#075985").pack(anchor="w", pady=(10, 4))
    ttk.Label(body, text="Panel không ghi CSV. Giữ subscriber đang chạy. Thêm/xóa nhà: sửa config/homes.json rồi khởi động lại subscriber và simulator.", wraplength=1000).pack(anchor="w")

    def fill_home_controls(event=None):
        state = current["state"]
        if state and selected.get() in state.get("homes", {}):
            home = state["homes"][selected.get()]
            pv_choice.set("Bật" if home.get("pv_enabled", True) else "Tắt")
            multiplier.set(str(home.get("load_multiplier", 1)))

    home_combo.bind("<<ComboboxSelected>>", fill_home_controls)

    def select_row(event):
        # Refreshing a selected Treeview row may emit another selection event.
        # Never overwrite a user's unsent choice unless the selected HOUSE changed.
        if table.selection() and table.selection()[0] != selected.get():
            selected.set(table.selection()[0])
            fill_home_controls()

    table.bind("<<TreeviewSelect>>", select_row)

    def tick():
        messages = mailbox.take()
        if "connection" in messages:
            current["broker"], reason = messages.pop("connection")
            connection_text.set(f"MQTT {args.host}:{args.port} — " + ("đã kết nối" if current["broker"] else f"mất/chưa có kết nối ({reason})"))
        state = messages.pop("solar/simulator/state", None)
        if state and isinstance(state.get("run_id"), str):
            previous = current["state"]
            if state.get("status") == "offline" and previous and state["run_id"] == previous["run_id"]:
                previous["status"] = "offline"
            elif isinstance(state.get("homes"), dict) and 1 <= len(state["homes"]) <= 100:
                if previous is None or previous["run_id"] != state["run_id"]:
                    current["readings"].clear()
                    current["pending"].clear()
                    for item in table.get_children():
                        table.delete(item)
                    for home_id, home in state["homes"].items():
                        table.insert("", "end", iid=home_id, values=(home.get("name", home_id), "—", "—", "—", "Chờ dữ liệu"))
                    home_combo["values"] = list(state["homes"])
                    selected.set(next(iter(state["homes"])))
                    interval.set(str(state["publish_interval_seconds"]))
                    weather.set(state["weather"])
                current["state"] = state
                current["last_status"] = time.monotonic()
                if previous is None or previous["run_id"] != state["run_id"]:
                    fill_home_controls()
        state = current["state"]
        for topic, data in messages.items():
            if "/ack/" in topic:
                request_id = data.get("request_id")
                if isinstance(request_id, str) and request_id in current["pending"]:
                    pending = current["pending"].pop(request_id)
                    feedback.set(command_feedback(pending["command"]) if data.get("ok") else f"Simulator từ chối: {data.get('error')}")
            elif state and topic.endswith("/telemetry") and data.get("run_id") == state["run_id"]:
                try:
                    validate_reading(data, topic, state["homes"])
                    home_id = data["household_id"]
                    current["readings"][home_id] = data
                    home = state["homes"][home_id]
                    table.item(home_id, values=(home.get("name", home_id), f"{data['solar_power_kw']:.3f}", f"{data['load_power_kw']:.3f}", f"{data['net_power_kw']:+.3f}", data["timestamp"]), tags=("surplus" if data["net_power_kw"] >= 0 else "deficit",))
                except (ValueError, TypeError, KeyError):
                    pass
        for request_id, pending in list(current["pending"].items()):
            if time.monotonic() - pending["sent_at"] > 5:
                current["pending"].pop(request_id)
                feedback.set("Chưa nhận xác nhận lệnh. Kiểm tra trạng thái simulator trước khi gửi lại.")
        fresh = bool(state and current["broker"] and time.monotonic() - current["last_status"] <= 5)
        enabled = bool(fresh and state.get("controls_enabled") and state.get("status") in ("paused", "running") and not current["pending"])
        for widget in controls:
            widget.configure(state="normal" if enabled else "disabled")
        pv_combo.configure(state="readonly" if enabled else "disabled")
        load_input.configure(state="normal" if enabled else "disabled")
        if state:
            label = state.get("status") if fresh else "mất kết nối / dữ liệu trạng thái cũ"
            state_text.set(f"{label}  |  {state.get('completed_steps', 0)} đợt  |  {state.get('publish_interval_seconds')} giây/đợt  |  thời tiết: {state.get('weather')}  |  " + ("DATASET: khóa điều khiển" if not state.get("controls_enabled") else "INTERACTIVE"))
            home = state.get("homes", {}).get(selected.get(), {})
            house_text.set(f"{home.get('name', selected.get())} — lắp đặt {home.get('pv_kw', 0)} kW; PV {'BẬT' if home.get('pv_enabled') else 'TẮT'} (simulator); tải ×{home.get('load_multiplier', 1)}")
            reading = current["readings"].get(selected.get())
            pv_note.set(pv_status_text(home, reading, state.get("status"), fresh))
            if reading:
                scene.itemconfigure(meter_text, text=f"Phát {reading['solar_power_kw']:.3f} kW    |    Tiêu thụ {reading['load_power_kw']:.3f} kW    |    Ròng {reading['net_power_kw']:+.3f} kW")
                scene.itemconfigure(weather_text, text=f"{reading['timestamp']}    •    {reading['temperature_c']:.1f} °C    •    {reading['irradiance_w_m2']:.0f} W/m²    •    Mây {reading['cloud_cover']:.0%}")
            else:
                scene.itemconfigure(meter_text, text="Chờ số đo mới của nhà này...")
                scene.itemconfigure(weather_text, text="")
        root.after(200, tick)

    def close():
        client.disconnect()
        client.loop_stop()
        root.destroy()

    root.protocol("WM_DELETE_WINDOW", close)
    client.connect_async(args.host, args.port, keepalive=15)
    client.loop_start()
    root.after(100, tick)
    root.mainloop()


if __name__ == "__main__":
    main()
