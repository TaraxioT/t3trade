# Supply an independently verified Node image by sha256 digest at setup time.
ARG RUNNER_BASE_IMAGE
FROM ${RUNNER_BASE_IMAGE}
RUN npm install --prefix /opt/forge --ignore-scripts --no-audit --no-fund typescript@6.0.3
COPY runner.cjs /opt/forge/runner.cjs
RUN printf '#!/bin/sh\nexec node /opt/forge/runner.cjs typecheck\n' > /usr/local/bin/forge-typecheck \
 && printf '#!/bin/sh\nexec node /opt/forge/runner.cjs test\n' > /usr/local/bin/forge-test \
 && printf '#!/bin/sh\nexec node /opt/forge/runner.cjs evaluate\n' > /usr/local/bin/forge-evaluate \
 && printf '#!/bin/sh\nexec node /opt/forge/runner.cjs evaluate-v2\n' > /usr/local/bin/forge-evaluate-v2 \
 && printf '#!/bin/sh\nexec node /opt/forge/runner.cjs evaluate-policy\n' > /usr/local/bin/forge-evaluate-policy \
 && chmod 755 /usr/local/bin/forge-typecheck /usr/local/bin/forge-test /usr/local/bin/forge-evaluate /usr/local/bin/forge-evaluate-v2 /usr/local/bin/forge-evaluate-policy
USER 65534:65534
WORKDIR /work
