"""Real Python SDK/HTTP-Protobuf export from an isolated HTTP fixture."""
import json
import logging
import sys
import threading
import time
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse

from opentelemetry.trace import SpanKind
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, SpanExportResult
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader, MetricExportResult
from opentelemetry.sdk.metrics.view import View, ExplicitBucketHistogramAggregation
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter

logging.disable(logging.CRITICAL)
config = json.loads(sys.stdin.readline())
endpoint = urlparse(config['endpoint'])
assert endpoint.scheme == 'http' and endpoint.hostname == '127.0.0.1' and endpoint.path == '/ingest/otlp'
marker = 'SMOKE_PRIVATE_MARKER'
counts = {'traces': 0, 'metrics': 0, 'failures': 0}


class Traces(OTLPSpanExporter):
    def export(self, spans):
        result = super().export(spans)
        counts['traces'] += 1
        counts['failures'] += result != SpanExportResult.SUCCESS
        return result


class Metrics(OTLPMetricExporter):
    def export(self, metrics_data, timeout_millis=10000, **kwargs):
        result = super().export(metrics_data, timeout_millis=timeout_millis, **kwargs)
        counts['metrics'] += 1
        counts['failures'] += result != MetricExportResult.SUCCESS
        return result


resource = Resource({'service.name': config['resourceName'], 'private.resource': marker})
headers = {'Authorization': config['authorization']}
traces = TracerProvider(resource=resource)
traces.add_span_processor(BatchSpanProcessor(Traces(endpoint=config['endpoint'] + '/v1/traces', headers=headers, timeout=5), schedule_delay_millis=60000))
reader = PeriodicExportingMetricReader(Metrics(endpoint=config['endpoint'] + '/v1/metrics', headers=headers, timeout=5), export_interval_millis=60000, export_timeout_millis=5000)
metrics = MeterProvider(resource=resource, metric_readers=[reader], views=[View(instrument_name='http.server.request.duration', aggregation=ExplicitBucketHistogramAggregation(boundaries=[0.001, 0.005, 0.01, 0.05, 0.1, 1]))])
tracer = traces.get_tracer('agent-town-python-sdk-smoke', '1.0.0')
duration = metrics.get_meter('agent-town-python-sdk-smoke', '1.0.0').create_histogram('http.server.request.duration', unit='s')
handled = 0


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        global handled
        start = time.perf_counter()
        handled += 1
        code = 503 if handled == 2 else 200
        attributes = {'http.request.method': 'GET', 'http.route': '/unreviewed/' + marker if handled == 3 else '/items/:id', 'http.response.status_code': code,
                      'url.full': 'http://127.0.0.1' + self.path, 'http.request.header.authorization': self.headers.get('Authorization'),
                      'http.request.body': marker, 'http.response.body': marker, 'agent_town.run_id': 'UNAPPROVED_SMOKE_RUN'}
        with tracer.start_as_current_span('GET ' + self.path, kind=SpanKind.SERVER, attributes=attributes) as span:
            self.rfile.read(int(self.headers.get('Content-Length', '0')))
            self.send_response(code)
            self.end_headers()
            self.wfile.write(marker.encode())
            duration.record(max(time.perf_counter() - start, 0.0001), attributes)
            span.add_event(marker, {'exception.message': marker})


server = HTTPServer(('127.0.0.1', 0), Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()


def hit(index):
    connection = HTTPConnection('127.0.0.1', server.server_port, timeout=5)
    try:
        connection.request('GET', '/items/' + marker + '-' + str(index) + '?api_key=' + marker, body=marker, headers={'Authorization': 'Bearer ' + marker})
        response = connection.getresponse()
        response.read()
    finally:
        connection.close()


try:
    hit(1)
    hit(2)
    assert traces.force_flush(timeout_millis=10000)
    assert metrics.force_flush(timeout_millis=10000)
    assert counts['failures'] == 0, 'A real Python SDK export failed.'
    print(json.dumps({'phase': 'flushed', 'requests': 2}), flush=True)
    assert sys.stdin.readline().strip() == 'continue'
    hit(3)
    server.shutdown()
    thread.join(timeout=5)
    traces.shutdown()
    metrics.shutdown(timeout_millis=10000)
    assert counts['failures'] == 0 and counts['traces'] >= 2 and counts['metrics'] >= 2
    print(json.dumps({'phase': 'done', 'requests': handled, 'exports': counts, 'shutdown': True}), flush=True)
finally:
    server.server_close()
