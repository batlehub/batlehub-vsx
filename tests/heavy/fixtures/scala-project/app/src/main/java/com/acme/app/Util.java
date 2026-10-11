package com.acme.app;

/** The Java half of the mixed module (RFC 0009 case 4). */
public final class Util {
    private Util() {}

    public static String banner(String s) {
        return "Hello from app: " + s;
    }
}
