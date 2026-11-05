# Stage 1: build the React frontend
FROM node:20-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npx vite build

# Stage 2: FastAPI serves the API and the built frontend under /lotwise/
FROM python:3.11-slim
WORKDIR /app
COPY api/requirements.txt api/requirements.txt
RUN pip install --no-cache-dir -r api/requirements.txt
COPY api api
COPY db db
COPY --from=web /web/dist web/dist
ENV LOTWISE_BASE_PATH=/lotwise LOTWISE_COOKIE_SECURE=1 LOTWISE_STAGE=skeleton
WORKDIR /app/api
CMD ["sh", "-c", "uvicorn lotwise.main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers"]
