"""Reproducible, labelled disturbances for the variable community scenario."""
import math
from .model import SolarModel

WEATHER = ('sunny', 'sunny', 'cloudy', 'rainy', 'sunny', 'cloudy',
           'rainy', 'sunny', 'cloudy', 'sunny', 'cloudy', 'sunny')
LOAD = (1.0, 1.25, 1.5, 1.8, 1.15, 1.35, 2.1, .9, 1.6, 1.1, 1.25, .85)
EVENTS = ('Nắng ổn định', 'Tải bắt đầu tăng', 'Mây che, tải cao', 'Mưa; Nhà 1 gián đoạn giao',
          'Nắng trở lại; Nhà 1 giao thiếu', 'Mây và sự cố Nhà 7', 'Mưa, đỉnh phụ tải',
          'Nguồn cung phục hồi', 'Tải tăng; sự cố Nhà 1 và Nhà 8', 'Giao đủ, phục hồi uy tín',
          'Mây nhẹ, tải giảm', 'Nắng, kết thúc phục hồi')


def community_reading(config, home, timestamp, run_id, sequence):
    if type(sequence) is not int or not 0 <= sequence < len(WEATHER):
        raise ValueError('Community sequence must be an integer in 0..11')
    index = int(home['id'].split('_')[1])
    settings = dict(home)
    # The same weather reaches all homes; appliance schedules differ by household.
    diversity = 1 + .22 * math.sin(index * 1.9 + sequence * .8)
    settings['load_multiplier'] = LOAD[sequence] * diversity
    model = SolarModel(config['seed'] + sequence * 101, {home['id']: settings}, WEATHER[sequence])
    reading = next(model.generate(timestamp, config['step_seconds'], run_id, sequence))
    reading.update(scenario_profile='community',
                   scenario_event=EVENTS[sequence], weather=WEATHER[sequence])
    return reading
