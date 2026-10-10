package com.acme.core;

import java.util.List;

public class Customer {
    private String name;
    private int age;
    private final String id;
    private final boolean active = true;
    private List<String> tags;
    private static int count;
    public static CustomerBuilder builder() {
        return new CustomerBuilder();
    }
    Customer(CustomerBuilder b) {
        this.name = b.name;
        this.age = b.age;
        this.id = b.id;
        this.tags = b.tags;
    }
}
