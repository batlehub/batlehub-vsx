package com.acme.app;

import com.acme.core.Greeter;
import com.acme.core.Person;

public class Main {
    public static void main(String[] args) {
        Greeter g = new Greeter();
        g.add(new Person("Ada", 36));
        System.out.print(g.all());
    }
}
