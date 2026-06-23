FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    GARMINTOKENS=/tmp/garminconnect-tokens

WORKDIR /app

RUN pip install --no-cache-dir garminconnect curl_cffi

COPY runner_server.py /app/runner_server.py

EXPOSE 8080

CMD ["python", "/app/runner_server.py"]
