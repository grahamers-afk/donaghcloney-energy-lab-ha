ARG BUILD_FROM=ghcr.io/home-assistant/base:3.24
FROM ${BUILD_FROM}

RUN apk add --no-cache python3

WORKDIR /app
COPY server.py /app/server.py
COPY app/dist/ /app/dist/

EXPOSE 8099
CMD ["python3", "/app/server.py"]
