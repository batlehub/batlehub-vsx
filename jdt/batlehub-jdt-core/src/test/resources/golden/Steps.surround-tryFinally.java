package com.acme.app;

import java.io.FileInputStream;
import java.io.IOException;

public class Steps {
    void run() throws IOException {
        int a = 1; // first
        try {
            System.out.println(a);
        } finally {
        }
        int b = a + 1;
        System.out.println(b);
    }

    void resource() throws IOException {
        FileInputStream in = new FileInputStream("x");
        int c = in.read();
        System.out.println(c);
    }

    static void later() {
        var v = 1;
        System.out.println(v);
    }

    int field = 1 + 2;
}
