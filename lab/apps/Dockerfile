# A stock `ng new --ssr` app with one case from this directory copied over it.
#
#   docker build --build-arg CASE=a1only -t ssr-redirect-poc:a1only lab/apps
#
# Angular is pinned to the release the README was measured on. Pass
# NG_CLI / NG_FRAMEWORK to build the same case against another release.

FROM node:22.23.3-alpine AS scaffold
ARG NG_CLI=22.2.2
ARG NG_FRAMEWORK=22.2.2
ENV NG_CLI_ANALYTICS=false
WORKDIR /src
RUN npx --yes @angular/cli@${NG_CLI} new app \
      --ssr --routing --style=css --skip-git --skip-install --defaults

# ng new writes caret ranges, so pin every Angular package explicitly.
WORKDIR /src/app
RUN npm install --save-exact \
      @angular/build@${NG_CLI} \
      @angular/cli@${NG_CLI} \
      @angular/ssr@${NG_CLI} \
      @angular/common@${NG_FRAMEWORK} \
      @angular/compiler@${NG_FRAMEWORK} \
      @angular/compiler-cli@${NG_FRAMEWORK} \
      @angular/core@${NG_FRAMEWORK} \
      @angular/forms@${NG_FRAMEWORK} \
      @angular/platform-browser@${NG_FRAMEWORK} \
      @angular/platform-server@${NG_FRAMEWORK} \
      @angular/router@${NG_FRAMEWORK}

FROM scaffold AS build
ARG CASE=full
COPY ${CASE}/src/ src/
RUN npm run build

FROM node:22.23.3-alpine
WORKDIR /app
COPY --from=build /src/app/dist/app/ ./dist/app/
ENV PORT=4000
ENV NODE_ENV=production
EXPOSE 4000
CMD ["node", "dist/app/server/server.mjs"]
