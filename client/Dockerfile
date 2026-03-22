# Build stage
FROM node:20-alpine as build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

# Setup build arg for Vite
ARG VITE_API_URL=http://localhost:3000
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

# Serve stage
FROM nginx:alpine
# [Phase 21 Fix] vite.config.js outDir is '../public-react', matching the WORKDIR /app
COPY --from=build /public-react /usr/share/nginx/html

# Enable SPA Routing + API Proxy in Nginx
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
