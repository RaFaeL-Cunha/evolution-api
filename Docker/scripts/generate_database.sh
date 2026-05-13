#!/bin/bash

source ./Docker/scripts/env_functions.sh

if [ "$DOCKER_ENV" != "true" ]; then
    export_env_vars
fi

if [[ "$DATABASE_PROVIDER" == "postgresql" || "$DATABASE_PROVIDER" == "mysql" || "$DATABASE_PROVIDER" == "psql_bouncer" ]]; then
    export DATABASE_URL
    echo "Generating database for $DATABASE_PROVIDER"
    echo "Database URL: $DATABASE_URL"
    
    # Retry logic for Prisma generate (network issues)
    MAX_RETRIES=3
    RETRY_COUNT=0
    
    while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
        echo "Attempt $((RETRY_COUNT + 1)) of $MAX_RETRIES..."
        npm run db:generate
        
        if [ $? -eq 0 ]; then
            echo "Prisma generate succeeded"
            break
        else
            RETRY_COUNT=$((RETRY_COUNT + 1))
            if [ $RETRY_COUNT -lt $MAX_RETRIES ]; then
                echo "Prisma generate failed, retrying in 5 seconds..."
                sleep 5
            else
                echo "Prisma generate failed after $MAX_RETRIES attempts"
                exit 1
            fi
        fi
    done
else
    echo "Error: Database provider $DATABASE_PROVIDER invalid."
    exit 1
fi