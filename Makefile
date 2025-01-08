ifneq (,$(wildcard ./.env))
	include .env
	export
	ENV_FILE_PARAM = --env-file .env
endif

build:
	docker-compose up --build --remove-orphans

build-prod:
	docker-compose -f docker-compose.yml -f docker-compose.prod.yml up --build --remove-orphans

up:
	docker-compose up

up-d:
	docker-compose up -d

up-d-prod:
	docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d

up-d-prod-build:
	docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build --remove-orphans

up-d-prod-build-node:
	docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-deps --build --remove-orphans node-app

up-d-prod-build-node-force:
	docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d --force-recreate --no-deps --build --remove-orphans node-app

prod-push-node:
	docker-compose -f docker-compose.yml -f docker-compose.prod.yml push node-app

prod-pull-node:
	docker-compose -f docker-compose.yml -f docker-compose.prod.yml pull node-app

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

dcps:
	docker-compose ps -a

images:
	docker images -a

monitor-node:
	docker-compose logs -f -t node-app

monitor-redis:
	docker-compose logs -f -t redis

monitor-nginx:
	docker-compose logs -f -t nginx

clean-up-deep:
	docker image prune --all -f; docker container prune -f; docker volume prune -f; docker rmi $(docker images -q); docker rmi $(docker images -q -f dangling=true); docker rmi $(docker images | grep "^<none>" | awk "{print $3}"); docker volume rm $(docker volume ls -qf dangling=true);

prune-force:
	docker system prune -a -f; docker volume prune --force; docker image prune --force; docker container prune --force; docker volume prune -f;