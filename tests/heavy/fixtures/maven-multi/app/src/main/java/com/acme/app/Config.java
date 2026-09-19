package com.acme.app;

/** The root of RFC 0012's chain: `config.getServer()` is what the server proposes. */
public class Config {
    private final Server server = new Server("localhost", 8080);

    public Server getServer() {
        return server;
    }
}
