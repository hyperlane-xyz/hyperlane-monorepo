# Use Debian as the base image
FROM debian:bookworm-slim

# Update package list and install curl
RUN apt-get update && \
    apt-get install -y curl && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install logdy using the official installation script
RUN curl https://logdy.dev/install.sh | sh

# Set the working directory
WORKDIR /app

# Expose the default logdy port (if applicable)
EXPOSE 8080

# Set logdy as the default command
CMD ["logdy"]
