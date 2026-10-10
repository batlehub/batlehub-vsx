package com.acme.app;

import java.io.FileInputStream;
import java.io.IOException;

public class Steps {
    void run() throws IOException {
        int a = 1; // first
        System.out.println(a);
        int b = a + 1;
        System.out.println(b);
    }

    void resource() throws IOException {
        int c;
        try (FileInputStream in = new FileInputStream("x")) {
            c = in.read();
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
        System.out.println(c);
    }

    static void later() {
        var v = 1;
        System.out.println(v);
    }

    int field = 1 + 2;
}
