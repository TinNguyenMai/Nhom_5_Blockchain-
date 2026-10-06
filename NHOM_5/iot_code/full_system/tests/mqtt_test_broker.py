"""Close every test transport, including clients that leave before CONNECT.

Python 3.12 Server.wait_closed waits for all transports. Track the accepted
streams so broker cleanup is bounded even when amqtt has no session for one.
This changes test teardown only, not application message handling.
"""
from amqtt.broker import Broker as AMQTTBroker


class Broker(AMQTTBroker):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.test_writers = set()

    async def stream_connected(self, reader, writer, listener_name):
        self.test_writers.add(writer)
        try:
            await super().stream_connected(reader, writer, listener_name)
        finally:
            writer.close()
            await writer.wait_closed()
            self.test_writers.discard(writer)

    async def shutdown(self):
        for writer in list(self.test_writers):
            writer.close()
        await super().shutdown()
