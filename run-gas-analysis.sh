#!/bin/bash
for i in $(seq 1 16); do
    echo "=== Run $i/16 ==="
    node --expose-gc node_modules/.bin/hardhat run simulations/fifo-gas/run.ts
    echo "=== Run $i/16 complete ==="
done
echo "=== All done ==="

for i in $(seq 1 16); do
    echo "=== Run $i/16 ==="
    node --expose-gc node_modules/.bin/hardhat run simulations/pfc-gas/run.ts
    echo "=== Run $i/16 complete ==="
done
for i in $(seq 1 16); do
    echo "=== Run $i/16 ==="
    node --expose-gc node_modules/.bin/hardhat run simulations/psc-gas/run.ts
    echo "=== Run $i/16 complete ==="
done
echo "=== All done ==="
