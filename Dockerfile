# Fetching the minified node image on alpine linux
FROM node:slim

# Declaring env
ENV NODE_ENV development

# Setting up the work directory
WORKDIR /geokurs_base_stations

# Copying all the files in our project
COPY . .

# Installing nano and other dependencies
RUN apt-get update && apt-get install -y nano && rm -rf /var/lib/apt/lists/* \
    && npm install

# Exposing the port
EXPOSE 3456

# Starting our application
CMD [ "node", "index.js" ]
