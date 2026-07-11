FROM python:3.11-slim

WORKDIR /app

# Copy requirements and install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application files
COPY . .

# Environment variables defaults
ENV PORT=5005
ENV BIND_HOST=0.0.0.0

# Expose the default port
EXPOSE 5005

# Run the application
CMD ["gunicorn", "--workers", "1", "--threads", "4", "--bind", "0.0.0.0:5005", "app:app"]
