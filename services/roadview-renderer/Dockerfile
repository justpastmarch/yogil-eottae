FROM mcr.microsoft.com/playwright:v1.56.1-noble
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY contract.mjs request-policy.mjs server.mjs ./
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3101
USER pwuser
EXPOSE 3101
CMD ["node", "server.mjs"]
