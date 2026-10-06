FROM python:3.12-slim

WORKDIR /app

# Install dependencies first, separately from app code, so Docker can cache
# this layer and skip reinstalling packages when only app code changes.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

# The app applies these migrations at startup (app/migrations.py).
COPY alembic.ini .
COPY alembic/ ./alembic/

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]