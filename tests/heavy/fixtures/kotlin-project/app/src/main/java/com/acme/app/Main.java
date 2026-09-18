package com.acme.app;

/** The Java half of the mixed module: it calls the Kotlin one. */
public final class Main {
    public static void main(String[] args) {
        System.out.println(Banner.banner(args.length > 0 ? args[0] : "world"));
    }
}
