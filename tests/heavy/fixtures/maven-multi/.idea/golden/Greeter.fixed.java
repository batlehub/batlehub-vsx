package com.acme.core;

import java.util.ArrayList;
import java.util.List;

public class Greeter {
    private final List<Person> people = new ArrayList<>();
    public void add(Person p) {
        people.add(p);
    }

    public String all() {
        String out = "";
        for (Person p : people) {
            out = out + p.greeting() + "\n";
        }
        return out;
    }

    public boolean isEmpty() {
        return people.isEmpty();
    }
}
