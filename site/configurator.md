---
title: Relay configurator
description: Build a cinderous.config.json and a deployment package for your own relay, entirely in your browser.
head:
  - - meta
    - http-equiv: Content-Security-Policy
      content: "connect-src 'none'; form-action 'none'; base-uri 'self'"
---

<script setup>
import WebConfigurator from './.vitepress/components/WebConfigurator.vue';
</script>

# Relay configurator

Pick where the relay will run and what it allows. The page checks your choices with the same rules as `cinderous init` and `cinderous config validate`, then gives you the config file, a zip of the deployment package (the same files `cinderous relay build` writes), and the one-line command to build it yourself. Design: [SDK ADR 0142](/docs/adr/0142-web-configurator).

<ClientOnly>
  <WebConfigurator locale="en" />
</ClientOnly>
