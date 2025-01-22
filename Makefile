ifneq (,$(wildcard ./.env))
	include .env
	export
	ENV_FILE_PARAM = --env-file .env
endif

build:
	docker-compose up --build --remove-orphans

no-cache-build:
	docker-compose build --no-cache app

build-prod:
	docker-compose -f docker-compose.yml -f docker-compose.prod.yml up --build --remove-orphans

up:
	docker-compose up

up-d:
	docker-compose up -d

up-d-prod:
	docker-compose -f docker-compose.yml up -d

up-d-prod-build:
	docker-compose -f docker-compose.yml up -d --build --remove-orphans

up-d-prod-build-node:
	docker-compose -f docker-compose.yml up -d --no-deps --build --remove-orphans app

up-d-prod-build-node-force:
	docker-compose -f docker-compose.yml up -d --force-recreate --no-deps --build --remove-orphans app

prod-push-node:
	docker-compose -f docker-compose.yml push app

prod-pull-node:
	docker-compose -f docker-compose.yml pull app

build-image:
	docker build -t manshooras/screenshot-service:latest .

push-image:
	docker push manshooras/screenshot-service:latest

pull-image:
	docker pull manshooras/screenshot-service:latest

down:
	docker-compose down

down-V:
	docker-compose down -v

volume:
	docker volume inspect screenshot-api_redisdata

monitor-all:
	docker-compose logs

dps:
	docker ps -a

setup-permissions:
	mkdir -p public/screenshots public/gifs temp
	chmod -R 755 public temp
	chown -R 1000:1000 public temp

build-with-permissions: setup-permissions
	docker-compose build --no-cache app

up-with-permissions: setup-permissions
	docker-compose up -d

deploy: setup-permissions pull-image
	docker-compose up -d

dcps:
	docker-compose ps -a

images:
	docker images -a

monitor-node:
	docker-compose logs -f -t app

monitor-redis:
	docker-compose logs -f -t redis

monitor-nginx:
	docker-compose logs -f -t nginx

clean-up-deep:
	docker image prune --all -f; docker container prune -f; docker volume prune -f; docker rmi $(docker images -q); docker rmi $(docker images -q -f dangling=true); docker rmi $(docker images | grep "^<none>" | awk "{print $3}"); docker volume rm $(docker volume ls -qf dangling=true);

prune-force:
	docker system prune -a -f; docker volume prune --force; docker image prune --force; docker container prune --force; docker volume prune -f;

# Add these to your Makefile
check-chrome:
	ps aux | grep -i chrom | grep -v grep

kill-chrome:
	pkill -f "chromium" || true
	pkill -f "chrome" || true
	pkill -f "Chrome" || true

kill-node:
	pkill -f "node" || true

cleanup-all: kill-chrome kill-node
	docker-compose down
	docker system prune -f
	docker volume prune -f

clean-zombies:
	pkill -9 -f "chrome_crashpad"
	pkill -9 -f "chromium"
	for pid in $$(ps -A -ostat,ppid | grep -e '[zZ]' | awk '{print $$2}'); do kill -9 $$pid; done