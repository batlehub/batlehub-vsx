package com.acme.app;

import static org.junit.jupiter.api.Assertions.assertTrue;

import com.acme.core.Greeter;
import com.acme.core.Person;
import org.junit.jupiter.api.Test;

class MainTest {
    @Test
    void greets() {
        Greeter g = new Greeter();
        g.add(new Person("Ada", 36));
        assertTrue(g.all().contains("Ada"));
    }
}
