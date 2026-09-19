package com.acme.core;

/** The accessor class of the fixture: fields without getters, for the Generate menu. */
public class Person {
    private String name;
    private int age;
    private final boolean active = true;
    private static int count;

    public Person(String name, int age) {
        this.name = name;
        this.age = age;
        count++;
    }

    public String greeting() {
        return "Hello, " + name + " (" + age + ")";
    }

    public static int created() {
        return count;
    }
}
