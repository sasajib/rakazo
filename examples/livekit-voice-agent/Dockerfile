FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=/opt/venv PATH="/opt/venv/bin:$PATH"
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY agent.py conversation.py rakazo_client.py token_server.py ./
COPY web ./web
# Silero VAD weights, so a worker starts without network access to Hugging Face.
RUN python agent.py download-files
CMD ["python", "agent.py", "start"]
